import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, '.qa'), { recursive: true });
const directory = await mkdtemp(path.join(root, '.qa', 'agy-sharing-'));
const fixture = path.join(directory, 'work/fixture');
await mkdir(fixture, { recursive: true });
const repo = path.join(directory, 'repo & 工作区');
await mkdir(repo);
function git(cwd, ...args) {
    return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
git(repo, 'init', '-b', 'fixture');
await writeFile(path.join(repo, 'tracked.txt'), 'committed');
git(repo, 'add', 'tracked.txt');
git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Seed fixture');
await writeFile(path.join(repo, 'tracked.txt'), 'uncommitted source edit');
await writeFile(path.join(fixture, 'acp'), `
    const { createInterface } = require('node:readline');
    const { appendFileSync } = require('node:fs');
    const options = [{ id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash' }];
    let serial = 0;
    const sessions = new Map();
    const send = (fields) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...fields }) + '\\n');
    const reply = (id, result) => send({ id, result });
    function update(sessionId, body) { send({ method: 'session/update', params: { sessionId, update: body } }); }
    function finish(sessionId, stopReason) {
        const session = sessions.get(sessionId);
        if (!session?.promptId) return;
        reply(session.promptId, { stopReason });
        delete session.promptId;
    }
    createInterface({ input: process.stdin }).on('line', (line) => {
        const { id, method, params, result } = JSON.parse(line);
        if (method === 'initialize') {
            appendFileSync('processes.jsonl', JSON.stringify(process.pid) + '\\n');
            reply(id, { protocolVersion: 1, agentCapabilities: { loadSession: true } });
        } else if (method === 'session/new') {
            const sessionId = 'fixture-' + ++serial;
            sessions.set(sessionId, {});
            update(sessionId, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: sessionId }] });
            reply(id, { sessionId, configOptions: options });
        } else if (method === 'session/set_config_option') {
            reply(id, { configOptions: options });
        } else if (method === 'session/prompt') {
            const session = sessions.get(params.sessionId);
            session.promptId = id;
            send({ id: 'approval:' + params.sessionId, method: 'session/request_permission', params: {
                sessionId: params.sessionId, toolCall: { toolCallId: params.sessionId, title: 'Fixture operation' },
                options: [{ optionId: 'once', kind: 'allow_once', name: 'Allow once' }]
            } });
        } else if (method === 'session/cancel') {
            finish(params.sessionId, 'cancelled');
        } else if (method === 'session/close') {
            sessions.delete(params.sessionId);
            reply(id, {});
        } else if (typeof id === 'string' && id.startsWith('approval:')) {
            const sessionId = id.slice('approval:'.length);
            if (result.outcome.outcome === 'selected') {
                update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: sessionId + ' answer' } });
                finish(sessionId, 'end_turn');
            } else finish(sessionId, 'cancelled');
        }
    });
`);
const osEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'OS', 'TEMP', 'TMP'].includes(name.toUpperCase())));
const bridge = spawn(process.execPath, [path.join(root, 'plugin/service.mjs')], {
    env: { ...osEnv, AGY_BIN: process.execPath, AGENT_DOCK_HOME: directory, AGENT_DOCK_STATE_DIR: directory },
    stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true
});
function alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function until(check) {
    const end = Date.now() + 10000;
    do {
        const value = await check();
        if (value) return value;
        await delay(30);
    } while (Date.now() < end);
    throw new Error('Timed out waiting for shared AGY fixture');
}
async function processIds() {
    const log = await readFile(path.join(fixture, 'processes.jsonl'), 'utf8').catch(() => '');
    return log.trim().split('\n').filter(Boolean).map(Number);
}
try {
    const local = await until(async () => JSON.parse(await readFile(path.join(directory, '.local.json'), 'utf8').catch(() => 'null')));
    async function call(name, args, ok = true) {
        const response = await fetch(local.url + '/tool', {
            method: 'POST', headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, arguments: args }), signal: AbortSignal.timeout(8000)
        });
        const result = await response.json();
        assert.equal(response.ok, ok, result.error);
        return result;
    }
    function spawnAgent(name, worktreeRepo) { return call('agent_spawn', { provider: 'agy', name, worktreeRepo }); }
    function get(agent) { return call('agent_get', { id: agent.id }); }
    async function status(agent, expected) {
        return until(async () => {
            const state = await get(agent);
            return state.status === expected ? state : null;
        });
    }
    await call('agent_spawn', { provider: 'agy', name: 'Invalid', worktreeRepo: 'relative-path' }, false);
    const [a, b] = await Promise.all([spawnAgent('A', repo), spawnAgent('B', repo)]);
    assert.notEqual(a.cwd, b.cwd);
    assert.equal(git(repo, 'branch', '--show-current'), 'fixture');
    assert.equal(git(a.cwd, 'branch', '--show-current'), a.worktree.branch);
    assert.equal(git(b.cwd, 'branch', '--show-current'), b.worktree.branch);
    assert.equal(await readFile(path.join(a.cwd, 'tracked.txt'), 'utf8'), 'committed');
    await writeFile(path.join(a.cwd, 'tracked.txt'), 'worktree A edit');
    assert.equal(await readFile(path.join(b.cwd, 'tracked.txt'), 'utf8'), 'committed');
    assert.equal(await readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'uncommitted source edit');
    const [pid] = await processIds();
    assert.deepEqual(await processIds(), [pid], 'One process and one initialize for both sessions');
    for (const agent of [a, b]) assert.deepEqual(agent.availableCommands.map(({ name }) => name), [agent.sessionId]);
    await Promise.all([a, b].map(({ id }) => call('agent_send', { id, prompt: 'Synthetic only' })));
    const [blockedA, blockedB] = await Promise.all([status(a, 'blocked'), status(b, 'blocked')]);
    assert.equal(blockedA.pendingPermissions.length, 1);
    assert.equal(blockedB.pendingPermissions.length, 1);
    const approvalB = blockedB.pendingPermissions[0].id;
    await call('agent_approve', { id: a.id, requestId: approvalB, optionId: 'once' }, false);
    await call('agent_cancel', { id: a.id });
    const cancelled = await status(a, 'cancelled');
    assert.deepEqual(cancelled.pendingPermissions, []);
    const archivedA = await call('agent_close', { id: a.id });
    assert.equal(archivedA.status, 'closed');
    assert.equal(archivedA.archive.process, 'shared_kept');
    assert.equal(await readFile(path.join(a.cwd, 'tracked.txt'), 'utf8'), 'worktree A edit');
    assert.ok(alive(pid));
    assert.equal((await status(b, 'blocked')).pendingPermissions[0].id, approvalB);
    await call('agent_approve', { id: b.id, requestId: approvalB, optionId: 'once' });
    const completed = await status(b, 'completed');
    assert.deepEqual(completed.events.filter((event) => event.params?.update?.sessionUpdate === 'agent_message_chunk').map((event) => event.params.update.content.text), [b.sessionId + ' answer']);
    for (const [agent, state] of [[a, cancelled], [b, completed]]) {
        assert.ok(state.events.filter((event) => event.params?.sessionId).every((event) => event.params.sessionId === agent.sessionId));
    }
    const archivedB = await call('agent_close', { id: b.id });
    assert.equal(archivedB.archive.process, 'tree_stopped');
    await until(() => !alive(pid));

    const [c, d] = await Promise.all([spawnAgent('C'), spawnAgent('D')]);
    assert.ok([c, d].every((agent) => agent.cwd === fixture && !agent.worktree));
    const [, crashedPid] = await processIds();
    assert.ok(crashedPid && crashedPid !== pid);
    process.kill(crashedPid);
    const failed = await Promise.all([status(c, 'error'), status(d, 'error')]);
    assert.ok(failed.every((state) => state.recovery.phase === 'failed' && state.events.some((event) => event.method === 'bridge/session_ready')));
    const replacement = await spawnAgent('Replacement');
    assert.equal((await processIds()).length, 3);
    await call('agent_close', { id: replacement.id });
    console.log(JSON.stringify({ passed: true, oneProcess: true, earlyUpdates: true, approvalIsolation: true, cancelIsolation: true, archiveIsolation: true, sharedDisconnect: true, newConnection: true, optInWorktrees: true, archiveKeepsDirtyWorktree: true }));
} finally {
    if (bridge.exitCode === null) { bridge.kill(); await once(bridge, 'exit'); }
    for (const pid of await processIds()) if (alive(pid)) process.kill(pid);
}
