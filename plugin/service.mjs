import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AcpClient } from './acp.mjs';
import { initializeParams } from './identity.mjs';
import { providers, providerList } from './providers.mjs';
import { configureSession } from './session-config.mjs';
import { stateRoot } from './paths.mjs';
import { SessionStore, applySessionEvent } from './session-store.mjs';
import { restoreSession, sessionParams } from './session-recovery.mjs';
import { panelSync } from './panel-sync.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(stateRoot, 'work/fixture');
const evidence = path.join(stateRoot, 'work/evidence');
await mkdir(fixture, { recursive: true });
await mkdir(evidence, { recursive: true });
const agents = new Map();
const store = new SessionStore(path.join(stateRoot, 'work/sessions'));
// Preserve explicitly archived probe sessions across a service upgrade, without auto-running them.
try {
    const archived = JSON.parse(await readFile(path.join(stateRoot, 'work/archived-sessions.json'), 'utf8'));
    for (const agent of archived) agents.set(agent.id, { ...agent, status: 'closed' });
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
for (const agent of store.load()) agents.set(agent.id, agent);
for (const agent of agents.values()) {
    agent.cwd ||= fixture;
    store.checkpoint(agent);
}
const token = randomBytes(32).toString('hex');
let journal = Promise.resolve();

function record(agent, method, params) {
    const event = { seq: agent.events.length + 1, at: new Date().toISOString(), method, params };
    applySessionEvent(agent, event);
    store.append(agent, event);
    // Serialize journal writes so disk order matches the event cursor order.
    journal = journal.then(() => appendFile(path.join(evidence, 'events.jsonl'), JSON.stringify({ agentId: agent.id, ...event }) + '\n'));
    journal.catch(console.error);
}

function snapshot(agent, after = 0) {
    return { id: agent.id, name: agent.name, provider: agent.provider || 'agy', owner: agent.owner, status: agent.status, sessionId: agent.sessionId,
        cwd: agent.cwd, info: agent.info, configOptions: agent.configOptions, result: agent.result, recovery: agent.recovery,
        availableCommands: agent.availableCommands || [], contextUsage: agent.contextUsage,
        pendingPermissions: agent.client?.permissionSnapshots() || [],
        error: agent.error, events: agent.events.filter((event) => event.seq > after), cursor: agent.events.length };
}

function createClient(agent, replaying = false) {
    const provider = providers[agent.provider];
    if (!provider) throw new Error('Unknown saved ACP provider');
    if (!provider.command) throw new Error('Antigravity CLI was not found. Install agy.exe or configure AGY_BIN / install.ps1 -AgyBin. Claude Code can be used independently.');
    const client = new AcpClient(provider.command, agent.cwd, function onEvent(method, params) {
        if (client.replaying) {
            if (params?.update?.sessionUpdate === 'available_commands_update') agent.availableCommands = params.update.availableCommands;
            return;
        }
        record(agent, method, params);
    }, {
        ...provider,
        onPermission: function permissionChanged(kind, permission) {
            if (kind === 'pending') {
                if (permission.params.sessionId !== agent.sessionId || !['running', 'blocked'].includes(agent.status)) {
                    agent.client.resolvePermission(permission.id, undefined, 'inactive_session');
                    return;
                }
                agent.status = 'blocked';
                record(agent, 'bridge/permission_pending', { ...permission.params, id: permission.id });
            } else {
                if (agent.status === 'blocked' && !agent.client.permissions.size) agent.status = 'running';
                record(agent, 'bridge/permission_resolved', { id: permission.id, outcome: permission.outcome, reason: permission.reason, optionKind: permission.optionKind });
            }
        }
    });
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
        // Preserve the requested model even if the process dies between session/new
        // (provider defaults) and configuration confirmation.
        agent.recovery = { phase: 'creating', previousStatus: 'idle', requested: { model: args.model ?? provider.defaultModel, thoughtLevel: args.thoughtLevel, permissionMode: args.permissionMode } };
        agents.set(agent.id, agent);
        store.checkpoint(agent);
        agent.client = createClient(agent);
        try {
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
            agent.client.stop();
            record(agent, 'bridge/error', { message: error.message });
            throw error;
        }
    }
    const agent = agents.get(args.id);
    if (!agent) throw new Error('Unknown agent id');
    if (name === 'agent_get') return snapshot(agent, args.after || 0);
    if (name === 'agent_configure') {
        if (!['idle', 'completed', 'cancelled'].includes(agent.status)) throw new Error(`Cannot configure in state ${agent.status}`);
        const previous = agent.status;
        agent.status = 'configuring';
        try { await configureSession(agent, args); }
        finally { agent.status = previous; record(agent, 'bridge/configured', { configOptions: agent.configOptions }); }
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
        agent.client.request('session/prompt', { sessionId: agent.sessionId, prompt: [{ type: 'text', text: args.prompt }] }, 600000).then((result) => {
            agent.client.cancelPermissions('turn_ended');
            agent.result = result;
            agent.status = result.stopReason === 'cancelled' ? 'cancelled' : 'completed';
            record(agent, 'bridge/turn_end', result);
        }).catch((error) => {
            agent.status = 'error';
            agent.error = error.message;
            // A timed-out turn must not continue silently in the background.
            agent.client.stop();
            record(agent, 'bridge/error', { message: error.message });
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
        if (agent.status === 'closed') return snapshot(agent, agent.events.length);
        if (['starting', 'configuring', 'running', 'blocked', 'cancelling'].includes(agent.status)) throw new Error('Cancel the active turn before closing');
        if (agent.sessionId && agent.status !== 'error') {
            try { await agent.client.request('session/close', { sessionId: agent.sessionId }); }
            catch (error) {
                // session/close is optional; terminating our child still releases local resources.
                if (!error.message.includes('-32601')) throw error;
            }
        }
        agent.client?.stop();
        agent.status = 'closed';
        record(agent, 'bridge/closed', {});
        return snapshot(agent, agent.events.length);
    }
    throw new Error('Unknown tool');
}

const recovering = [...agents.values()].filter((agent) => agent.status !== 'closed' && (agent.status !== 'error' || agent.recovery));
for (const agent of recovering) {
    agent.recovery = { ...agent.recovery, previousStatus: agent.recovery?.phase !== 'ready' && agent.recovery?.previousStatus || agent.status, phase: 'queued' };
    agent.status = 'starting';
    store.checkpoint(agent);
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
    await writeFile(path.join(stateRoot, '.local.json'), JSON.stringify({ url, token, pid: process.pid }, null, 4));
    console.log(JSON.stringify({ ready: true, url, pid: process.pid, fixture }));
    // Serve the registry while providers reconnect. Starting sessions reject input.
    // Loading never replays prompts or previous permission decisions.
    for (const agent of recovering) {
        await restoreSession(agent, createClient, record);
        store.checkpoint(agent);
    }
});
function shutdown() {
    for (const agent of agents.values()) agent.client?.stop();
    server.close();
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
