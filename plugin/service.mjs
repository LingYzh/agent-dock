import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AcpClient } from './acp.mjs';
import { AcpSessionPool } from './acp-pool.mjs';
import { initializeParams } from './identity.mjs';
import { providers, providerList } from './providers.mjs';
import { configureSession } from './session-config.mjs';
import { stateRoot } from './paths.mjs';
import { SessionStore, applySessionEvent } from './session-store.mjs';
import { restoreSession, sessionParams } from './session-recovery.mjs';
import { archiveSession } from './session-archive.mjs';
import { panelSync } from './panel-sync.mjs';
import { panelDetail } from './panel-detail.mjs';
import { createSessionWorktree } from './worktree.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(stateRoot, 'work/fixture');
const evidence = path.join(stateRoot, 'work/evidence');
await mkdir(fixture, { recursive: true });
await mkdir(evidence, { recursive: true });
const agents = new Map();
const store = new SessionStore(path.join(stateRoot, 'work/sessions'));
const pools = {
    agy: process.env.AGENT_DOCK_AGY_ISOLATED === '1' ? null : new AcpSessionPool(providers.agy, fixture),
    claude: process.env.AGENT_DOCK_CLAUDE_ISOLATED === '1' ? null : new AcpSessionPool(providers.claude, fixture)
};
// Preserve explicitly archived probe sessions across a service upgrade, without auto-running them.
try {
    const archived = JSON.parse(await readFile(path.join(stateRoot, 'work/archived-sessions.json'), 'utf8'));
    for (const agent of archived) agents.set(agent.id, { ...agent, status: 'closed' });
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
const persisted = store.load();
const persistedIds = new Set(persisted.map((agent) => agent.id));
for (const agent of persisted) agents.set(agent.id, agent);
for (const agent of agents.values()) {
    agent.cwd ||= fixture;
    if (!persistedIds.has(agent.id)) store.checkpoint(agent);
}
const token = randomBytes(32).toString('hex');
const leases = process.argv.includes('--mcp-managed') ? new Set() : null;
let idleShutdown;
let journal = Promise.resolve();

function record(agent, method, params, transition) {
    const event = { seq: agent.events.length + 1, at: new Date().toISOString(), method, params };
    // A failed disk write must not publish a successful local state transition.
    store.append(transition ? { ...agent, ...transition } : agent, event);
    if (transition) Object.assign(agent, transition);
    applySessionEvent(agent, event);
    // Serialize journal writes so disk order matches the event cursor order.
    journal = journal.then(() => appendFile(path.join(evidence, 'events.jsonl'), JSON.stringify({ agentId: agent.id, ...event }) + '\n'));
    journal.catch(console.error);
}

function snapshot(agent, after = 0) {
    return { id: agent.id, name: agent.name, provider: agent.provider || 'agy', owner: agent.owner, status: agent.status, sessionId: agent.sessionId,
        cwd: agent.cwd, worktree: agent.worktree, archive: agent.archive, info: agent.info, configOptions: agent.configOptions, result: agent.result, recovery: agent.recovery,
        availableCommands: agent.availableCommands || [], contextUsage: agent.contextUsage,
        pendingPermissions: agent.client?.permissionSnapshots() || [],
        error: agent.error, events: after >= agent.events.length ? [] : agent.events.filter((event) => event.seq > after), cursor: agent.events.length };
}

function createClient(agent, replaying = false) {
    const provider = providers[agent.provider];
    if (!provider) throw new Error('Unknown saved ACP provider');
    if (!provider.command) throw new Error('Antigravity CLI was not found. Install agy.exe or configure AGY_BIN / install.ps1 -AgyBin. Claude Code can be used independently.');
    function onEvent(method, params) {
        if (agent.status === 'closed') return;
        if (client.replaying) {
            if (params?.update?.sessionUpdate === 'available_commands_update') agent.availableCommands = params.update.availableCommands;
            return;
        }
        record(agent, method, params);
    }
    function onPermission(kind, permission) {
        if (kind === 'pending') {
            if (permission.params.sessionId !== agent.sessionId || !['running', 'blocked'].includes(agent.status)) {
                agent.client.resolvePermission(permission.id, undefined, 'inactive_session');
                return;
            }
            agent.status = 'blocked';
            record(agent, 'bridge/permission_pending', { ...permission.params, id: permission.id });
        } else {
            if (agent.status === 'closed') return;
            if (agent.status === 'blocked' && !agent.client.permissionSnapshots().length) agent.status = 'running';
            record(agent, 'bridge/permission_resolved', { id: permission.id, outcome: permission.outcome, reason: permission.reason, optionKind: permission.optionKind });
        }
    }
    function onDisconnect(error) {
        // Creation/recovery already handles its own rejected RPC. For existing
        // sessions publish the loss even if they had no request in flight.
        if (['starting', 'closed', 'error'].includes(agent.status)) return;
        const message = `共享 ${provider.name} ACP 进程已断开，历史已保留：${error.message}`;
        const transition = {
            status: 'error', error: message,
            recovery: { phase: 'failed', previousStatus: agent.status === 'configuring' ? 'idle' : agent.status }
        };
        try { record(agent, 'bridge/error', { message }, transition); }
        catch (error) {
            Object.assign(agent, transition);
            console.warn('Could not save ACP disconnect:', error.message);
        }
    }
    const pool = pools[agent.provider];
    const client = pool
        ? pool.acquire({ onEvent, onPermission, onDisconnect })
        : new AcpClient(provider.command, agent.cwd, onEvent, { ...provider, onPermission });
    client.replaying = replaying;
    return client;
}

async function invoke(name, args = {}) {
    if (name === 'panel_sync') return panelSync(agents, args);
    if (name === 'agent_list' || name === 'open_panel') {
        return { providers: providerList(), agents: [...agents.values()].map((agent) => ({ ...snapshot(agent, agent.events.length), events: undefined })) };
    }
    if (name === 'agent_spawn') {
        const providerId = args.provider || 'agy';
        const provider = providers[providerId];
        if (!provider) throw new Error('Unknown ACP provider');
        if (!provider.command) throw new Error('Antigravity CLI was not found. Run install.ps1 -CheckOnly for setup instructions, or select Claude Code.');
        const agent = { id: randomUUID(), name: args.name || `${provider.name} 子代理`, provider: providerId, owner: args.owner || 'agent-dock', cwd: fixture, status: 'starting', events: [] };
        if (args.worktreeRepo !== undefined) {
            agent.worktree = await createSessionWorktree(stateRoot, args.worktreeRepo, agent.id);
            agent.cwd = agent.worktree.path;
        }
        // Preserve the requested model even if the process dies between session/new
        // (provider defaults) and configuration confirmation.
        agent.recovery = { phase: 'creating', previousStatus: 'idle', requested: { model: args.model ?? provider.defaultModel, thoughtLevel: args.thoughtLevel, permissionMode: args.permissionMode } };
        agents.set(agent.id, agent);
        store.checkpoint(agent);
        try {
            agent.client = createClient(agent);
            agent.info = await agent.client.request('initialize', initializeParams());
            const session = await agent.client.request('session/new', sessionParams(agent), 60000);
            agent.sessionId = session.sessionId;
            agent.configOptions = session.configOptions;
            store.checkpoint(agent);
            await configureSession(agent, { ...args, model: args.model ?? provider.defaultModel });
            agent.status = 'idle';
            agent.recovery = undefined;
            record(agent, 'bridge/session_ready', { sessionId: agent.sessionId, configOptions: agent.configOptions });
            return snapshot(agent);
        } catch (error) {
            agent.status = 'error';
            agent.error = error.message;
            await agent.client?.stop();
            record(agent, 'bridge/error', { message: error.message });
            if (agent.worktree) throw new Error(`${error.message}；worktree 已保留：${agent.cwd}`, { cause: error });
            throw error;
        }
    }
    const agent = agents.get(args.id);
    if (!agent) throw new Error('Unknown agent id');
    if (name === 'panel_detail') return panelDetail(agent, args);
    if (name === 'agent_get') return snapshot(agent, args.after || 0);
    if (name === 'agent_configure') {
        if (!['idle', 'completed', 'cancelled'].includes(agent.status)) throw new Error(`Cannot configure in state ${agent.status}`);
        const previous = agent.status;
        agent.status = 'configuring';
        try { await configureSession(agent, args); }
        finally {
            if (agent.status === 'configuring') {
                agent.status = previous;
                record(agent, 'bridge/configured', { configOptions: agent.configOptions });
            }
        }
        return snapshot(agent);
    }
    if (name === 'agent_approve') {
        if (agent.status !== 'blocked') throw new Error('Agent is not waiting for a permission decision');
        const outcome = agent.client.resolvePermission(args.requestId, args.optionId);
        return { ...snapshot(agent, agent.events.length), permissionOutcome: outcome };
    }
    if (name === 'agent_wait') {
        const deadline = Date.now() + Math.min(args.timeoutMs ?? 10000, 25000);
        while (agent.events.length <= (args.after || 0) && ['running', 'cancelling'].includes(agent.status) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return snapshot(agent, args.after || 0);
    }
    if (name === 'agent_send') {
        if (!['idle', 'completed', 'cancelled'].includes(agent.status)) throw new Error(`Cannot prompt in state ${agent.status}`);
        if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('A nonempty prompt is required');
        // Do not send an unsupported UI slash command to the model as an ordinary paid prompt.
        const command = args.prompt.trim().match(/^\/(usage|context)\b/)?.[1];
        if (command && !agent.availableCommands?.some((item) => item.name === command)) throw new Error(`ACP agent does not advertise /${command}`);
        agent.status = 'running';
        agent.result = undefined;
        record(agent, 'bridge/prompt', { text: args.prompt });
        const client = agent.client;
        client.request('session/prompt', { sessionId: agent.sessionId, prompt: [{ type: 'text', text: args.prompt }] }, 600000).then((result) => {
            if (client.failure && agent.status === 'error') return;
            client.cancelPermissions('turn_ended');
            agent.result = result;
            agent.status = result.stopReason === 'cancelled' ? 'cancelled' : 'completed';
            record(agent, 'bridge/turn_end', result);
        }).catch(async (error) => {
            if (client.failure && agent.status === 'error') return;
            agent.status = 'error';
            agent.error = error.message;
            record(agent, 'bridge/error', { message: error.message });
            // Dedicated processes stop as before. A shared handle first tries
            // to cancel and close just its own timed-out session.
            await client.stop({ cancelTurn: error.message === 'ACP timeout: session/prompt' });
        });
        return snapshot(agent, agent.events.length);
    }
    if (name === 'agent_cancel') {
        if (!['running', 'blocked'].includes(agent.status)) throw new Error('No running turn');
        agent.status = 'cancelling';
        agent.client.notify('session/cancel', { sessionId: agent.sessionId });
        record(agent, 'bridge/cancel_sent', {});
        return snapshot(agent, agent.events.length);
    }
    if (name === 'agent_close') {
        await archiveSession(agent, record);
        return snapshot(agent, agent.events.length);
    }
    throw new Error('Unknown tool');
}

const recovering = [...agents.values()].filter((agent) => agent.status !== 'closed' && (agent.status !== 'error' || agent.recovery));
for (const agent of recovering) {
    agent.recovery = { ...agent.recovery, previousStatus: agent.recovery?.phase !== 'ready' && agent.recovery?.previousStatus || agent.status, phase: 'queued' };
    agent.status = 'starting';
}

const server = createServer(async function handleRequest(req, res) {
    try {
        if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
            res.writeHead(403).end();
            return;
        }
        if (req.method === 'GET' && req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
            res.end(await readFile(path.join(root, 'panel.html')));
            return;
        }
        if (req.headers.authorization !== `Bearer ${token}`) {
            res.writeHead(401).end();
            return;
        }
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
            res.writeHead(403).end();
            return;
        }
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end('{"ready":true}');
            return;
        }
        if (leases && req.method === 'GET' && req.url === '/lease') {
            clearTimeout(idleShutdown);
            leases.add(res);
            res.once('close', function hostDisconnected() {
                leases.delete(res);
                if (!leases.size) idleShutdown = setTimeout(shutdown, 5000);
            });
            res.writeHead(200, { 'Cache-Control': 'no-store' });
            res.flushHeaders();
            return;
        }
        if (req.method !== 'POST' || req.url !== '/tool') {
            res.writeHead(404).end();
            return;
        }
        let body = '';
        for await (const chunk of req) {
            body += chunk;
            if (body.length > 100000) throw new Error('Request too large');
        }
        const { name, arguments: args } = JSON.parse(body);
        const result = await invoke(name, args);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
    } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
    }
});
server.listen(0, '127.0.0.1', async function ready() {
    const url = `http://127.0.0.1:${server.address().port}`;
    await writeFile(path.join(stateRoot, '.local.json'), JSON.stringify({ url, token, pid: process.pid, managed: Boolean(leases) }, null, 4));
    // Startup gets a longer window for the first host to attach. The short
    // disconnect grace lets MCP reconnect without interrupting other chats.
    if (leases && !leases.size) idleShutdown ??= setTimeout(shutdown, 30000);
    console.log(JSON.stringify({ ready: true, url, pid: process.pid, fixture }));
    // Serve the registry while providers reconnect. Starting sessions reject input.
    // Loading never replays prompts or previous permission decisions.
    for (const agent of recovering) {
        await restoreSession(agent, createClient, record);
        store.checkpoint(agent);
    }
});
function shutdown() {
    for (const pool of Object.values(pools)) {
        try { pool?.stop(); }
        catch (error) { console.warn('Could not stop shared ACP process:', error.message); }
    }
    for (const agent of agents.values()) {
        if (agent.client?.shared) continue;
        try { agent.client?.stop(); }
        catch (error) { console.warn('Could not stop ACP process:', error.message); }
    }
    server.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
