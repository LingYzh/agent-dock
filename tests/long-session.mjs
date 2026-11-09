import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rmdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionStore } from '../plugin/session-store.mjs';
import { mergePanelState, panelSyncArgs, prependPanelHistory } from '../plugin/panel-state.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, '.qa'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.qa', 'long-session-'));
const fixture = path.join(directory, 'work/fixture');
await mkdir(fixture, { recursive: true });
// The provider is a real stdio subprocess, but never sends a model request.
await writeFile(path.join(fixture, 'acp'), `
    const { createInterface } = require('node:readline');
    const { writeFileSync } = require('node:fs');
    createInterface({ input: process.stdin }).on('line', (line) => {
        const { id, method, params } = JSON.parse(line);
        const reply = { jsonrpc: '2.0', id };
        if (method === 'initialize') reply.result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
        if (method === 'session/load') {
            writeFileSync(params.sessionId + '.pid', String(process.pid));
            reply.result = { configOptions: [] };
        }
        if (method === 'session/close') {
            writeFileSync(params.sessionId + '.close', 'requested');
            if (params.sessionId === 'slow') return;
            reply.error = { code: -32000, message: 'Synthetic close failure' };
        }
        process.stdout.write(JSON.stringify(reply) + '\\n');
    });
`);
const events = [];
for (let index = 0; index < 1200; index++) {
    events.push(
        { seq: events.length + 1, method: 'bridge/prompt', params: { text: `Synthetic turn ${index}` } },
        { seq: events.length + 2, method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Synthetic reply. '.repeat(80) } } } },
        { seq: events.length + 3, method: 'bridge/turn_end', params: { stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } } }
    );
}
const store = new SessionStore(path.join(directory, 'work/sessions'));
const slow = { id: randomUUID(), name: 'Long transcript', provider: 'agy', cwd: fixture, sessionId: 'slow', status: 'completed', events };
const reject = { ...slow, id: randomUUID(), sessionId: 'reject', events: [] };
for (const agent of [slow, reject]) store.checkpoint(agent);

const osEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'OS', 'TEMP', 'TMP'].includes(name.toUpperCase())));
const bridge = spawn(process.execPath, [path.join(root, 'plugin/service.mjs')], {
    env: { ...osEnv, AGY_BIN: process.execPath, AGENT_DOCK_HOME: directory, AGENT_DOCK_STATE_DIR: directory },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true
});
let stderr = '';
bridge.stderr.on('data', (chunk) => { stderr += chunk; });
async function until(check) {
    const deadline = Date.now() + 10000;
    do {
        const result = await check();
        if (result) return result;
        if (bridge.exitCode !== null) throw new Error(stderr || 'Fixture bridge exited');
        await delay(40);
    } while (Date.now() < deadline);
    throw new Error('Fixture bridge did not become ready');
}
try {
    const local = await until(async () => JSON.parse(await readFile(path.join(directory, '.local.json'), 'utf8').catch(() => 'null')));
    async function call(name, args, expectSuccess = true) {
        const response = await fetch(local.url + '/tool', {
            method: 'POST', headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(8000)
        });
        const result = await response.json();
        assert.equal(response.ok, expectSuccess, result.error);
        return result;
    }
    await until(async () => (await call('agent_list')).agents.every((agent) => agent.status === 'completed'));
    const first = await call('panel_sync', panelSyncArgs(undefined, slow.id));
    let loaded = first.agent;
    assert.equal(loaded.cursor, loaded.sourceCursor);
    assert.ok(loaded.events.length <= 200 && loaded.startCursor > 0);
    assert.equal(loaded.hasMore, false);
    assert.equal(loaded.usage.session.totalTokens, 6000);
    assert.equal(loaded.events[0].method, 'bridge/prompt');
    assert.deepEqual(Object.keys(await call('panel_sync', panelSyncArgs(loaded, slow.id, first.revision))), ['revision']);
    const prior = await call('panel_sync', { id: slow.id, before: loaded.startCursor, recent: true, revision: first.revision });
    loaded = prependPanelHistory(loaded, prior.agent);
    assert.equal(prependPanelHistory(loaded, prior.agent), loaded, 'Duplicate backwards page is ignored');
    assert.deepEqual(loaded.events.slice(0, -2), events.slice(loaded.startCursor));
    assert.equal(loaded.usage.session.turns, 1200);

    // A write failure cannot mark an uncommitted archive as closed.
    const journal = store.file(slow.id);
    await rename(journal, journal + '.held');
    await mkdir(journal);
    try {
        await call('agent_close', { id: slow.id }, false);
        assert.equal((await call('agent_get', { id: slow.id, after: loaded.cursor })).status, 'completed');
    } finally {
        await rmdir(journal);
        await rename(journal + '.held', journal);
    }
    for (const agent of [slow, reject]) {
        const archived = await call('agent_close', { id: agent.id });
        assert.equal(archived.status, 'closed');
        assert.equal(archived.archive.storage, 'saved');
        assert.equal(archived.archive.acp.state, agent === slow ? 'timeout' : 'failed');
        assert.equal(archived.archive.process, agent === slow ? 'shared_kept' : 'tree_stopped');
        assert.deepEqual(archived.events, []);
        assert.equal(await readFile(path.join(fixture, agent.sessionId + '.close'), 'utf8'), 'requested');
        assert.equal((await call('agent_close', { id: agent.id })).cursor, archived.cursor);
    }
    const closed = await call('panel_sync', panelSyncArgs(loaded, slow.id, first.revision));
    assert.deepEqual(closed.agent.events.map((event) => event.method), ['bridge/closed', 'bridge/archive_cleanup']);
    const merged = mergePanelState(loaded, closed.agent);
    assert.equal(merged.startCursor, loaded.startCursor);
    assert.equal(merged.status, 'closed');
    const reopened = store.load().find((agent) => agent.id === slow.id);
    assert.equal(reopened.status, 'closed');
    assert.equal(reopened.archive.acp.state, 'timeout');
    assert.deepEqual(reopened.events.slice(0, events.length), events);
    assert.equal(reopened.events.filter((event) => event.method === 'bridge/closed').length, 1);
    console.log(JSON.stringify({ passed: true, events: events.length, firstPage: first.agent.events.length, archive: ['timeout', 'provider error', 'disk failure', 'idempotent'], usage: 6000 }));
} finally {
    if (bridge.exitCode === null) {
        bridge.kill();
        await once(bridge, 'exit');
    }
    for (const id of ['slow', 'reject']) {
        const pid = Number(await readFile(path.join(fixture, id + '.pid'), 'utf8').catch(() => '0'));
        if (pid) { try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    }
}
