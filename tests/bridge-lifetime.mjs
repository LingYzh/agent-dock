import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionStore } from '../plugin/session-store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, '.qa'), { recursive: true });
const state = await mkdtemp(path.join(root, '.qa', 'bridge-lifetime-'));
const fixture = path.join(state, 'work/fixture');
await mkdir(fixture, { recursive: true });
// Each fake ACP agent owns a detached helper that survives a plain parent kill.
await writeFile(path.join(fixture, 'acp'), `
    const { createInterface } = require('node:readline');
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
    createInterface({ input: process.stdin }).on('line', (line) => {
        const { id, method, params } = JSON.parse(line);
        const reply = { jsonrpc: '2.0', id };
        if (method === 'initialize') reply.result = { protocolVersion: 1, agentCapabilities: { loadSession: true } };
        if (method === 'session/load') {
            writeFileSync(params.sessionId + '.pids', JSON.stringify({ agent: process.pid, helper: helper.pid }));
            reply.result = { configOptions: [] };
        }
        if (method === 'session/close') reply.error = { code: -32000, message: 'session closed' };
        process.stdout.write(JSON.stringify(reply) + '\\n');
    });
`);
const store = new SessionStore(path.join(state, 'work/sessions'));
const records = ['archive', 'stay'].map((sessionId) => ({ id: randomUUID(), name: sessionId, provider: 'agy', cwd: fixture, sessionId, status: 'completed', events: [] }));
for (const record of records) store.checkpoint(record);
const osEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'OS', 'TEMP', 'TMP'].includes(name.toUpperCase())));
const environment = { ...osEnv, AGY_BIN: process.execPath, AGENT_DOCK_HOME: state, AGENT_DOCK_STATE_DIR: state, AGENT_DOCK_AGY_ISOLATED: '1' };
const hosts = [];
let bridge;
function alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function waitFor(check, label) {
    const deadline = Date.now() + 10000;
    do {
        const result = await check();
        if (result) return result;
        await delay(50);
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
}
function openHost() {
    const host = spawn(process.execPath, [path.join(root, 'plugin/mcp.mjs')], {
        env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit']
    });
    hosts.push(host);
    let nextId = 0;
    let buffer = '';
    const pending = new Map();
    host.stdout.on('data', function receive(chunk) {
        buffer += chunk;
        let lineEnd;
        while ((lineEnd = buffer.indexOf('\n')) !== -1) {
            const message = JSON.parse(buffer.slice(0, lineEnd));
            buffer = buffer.slice(lineEnd + 1);
            pending.get(message.id)?.(message);
        }
    });
    function send(method, params, id) {
        host.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    }
    function request(method, params) {
        const id = ++nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending.delete(id); reject(new Error(`No MCP reply for ${method}`)); }, 10000);
            pending.set(id, (message) => {
                clearTimeout(timer);
                pending.delete(id);
                if (message.error || message.result?.isError) reject(new Error(message.error?.message || message.result.content[0].text));
                else resolve(message.result);
            });
            send(method, params, id);
        });
    }
    return {
        host,
        async connect() {
            await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'lifetime-fixture', version: '1' } });
            send('notifications/initialized');
        },
        async call(name, args = {}) { return (await request('tools/call', { name, arguments: args })).structuredContent; }
    };
}
async function readPids(sessionId) {
    return JSON.parse(await readFile(path.join(fixture, sessionId + '.pids'), 'utf8').catch(() => 'null'));
}

try {
    const first = openHost();
    await first.connect();
    await waitFor(async () => (await first.call('agent_list')).agents.every(({ status }) => status === 'completed'), 'ACP recovery');
    bridge = JSON.parse(await readFile(path.join(state, '.local.json'), 'utf8'));
    assert.equal(bridge.managed, true);
    const second = openHost();
    await second.connect();
    await second.call('agent_list');
    const archived = await readPids('archive');
    const staying = await readPids('stay');
    await delay(350);
    assert.ok(alive(archived.agent) && alive(archived.helper) && alive(staying.agent) && alive(staying.helper));
    assert.equal((await first.call('agent_close', { id: records[0].id })).status, 'closed');
    await waitFor(() => !alive(archived.agent) && !alive(archived.helper), 'archive process tree exit');
    first.host.stdin.end();
    await waitFor(() => !alive(first.host.pid), 'MCP stdin EOF');
    await delay(5250);
    assert.ok(alive(bridge.pid) && alive(staying.agent) && alive(staying.helper), 'Other host keeps the shared bridge alive');
    // Abrupt host exit closes its lease socket even without an EOF handler.
    second.host.kill();
    await waitFor(() => !alive(bridge.pid) && !alive(staying.agent) && !alive(staying.helper), 'last host process tree exit');
    const saved = store.load();
    assert.equal(saved.find(({ id }) => id === records[0].id).status, 'closed');
    assert.equal(saved.find(({ id }) => id === records[1].id).status, 'completed');
    console.log(JSON.stringify({ passed: true, archiveProviderAlreadyClosed: true, archiveHelperExited: true, firstHostEof: true, concurrentHostSurvives: true, lastHostAbruptExit: true, bridgeAndHelperExited: true, persistedSessions: 2 }));
} finally {
    for (const host of hosts) if (host.pid && alive(host.pid)) host.kill();
    bridge ??= JSON.parse(await readFile(path.join(state, '.local.json'), 'utf8').catch(() => 'null'));
    if (bridge && alive(bridge.pid)) {
        const taskkill = path.join(process.env.SystemRoot || process.env.WINDIR, 'System32/taskkill.exe');
        spawnSync(taskkill, ['/PID', String(bridge.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
    // Only fixture PIDs recorded in this run's fresh state directory.
    for (const record of records) {
        const pids = await readPids(record.sessionId);
        if (pids) for (const pid of Object.values(pids)) if (alive(pid)) process.kill(pid);
    }
}
