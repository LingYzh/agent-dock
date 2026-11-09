import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureService } from './ensure-service.mjs';
import { stateRoot } from './paths.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const icons = [{ src: `data:image/png;base64,${(await readFile(path.join(root, 'assets/icon.png'))).toString('base64')}`, mimeType: 'image/png', sizes: ['128x128'] }];
// Keep wire identifiers stable: existing Codex chats retain their original MCP connection.
const uri = 'ui://agy-acp-probe/panel-v2.html';
await mkdir(path.join(stateRoot, 'work/evidence'), { recursive: true });
const uiMetadata = {
    ui: { resourceUri: uri, visibility: ['model', 'app'] },
    'openai/ui': { entrypoints: [{ type: 'thread' }, { type: 'global' }], preferredModelDisplayMode: 'fullscreen' },
    'openai/outputTemplate': uri
};
const configProperties = {
    model: { type: 'string', minLength: 1, description: 'Exact model ID; ACP must confirm it. No silent fallback.' },
    thoughtLevel: { type: 'string', minLength: 1, description: 'Reasoning effort value from configOptions category thought_level (e.g. low, medium, high). Actual supported values depend on the agent/model; no silent fallback.' },
    permissionMode: { type: 'string', enum: ['default', 'plan'], description: 'Session permission mode. Existing agent allow/deny rules still apply; default does not guarantee a callback for every tool.' }
};
const definitions = [
    ['panel_sync', 'Incremental read-only panel synchronization. UI only.', { id: { type: 'string' }, after: { type: 'integer', minimum: 0 }, before: { type: 'integer', minimum: 1 }, recent: { type: 'boolean' }, compact: { type: 'boolean' }, status: { type: 'string' }, revision: { type: 'string' } }],
    ['panel_detail', 'Read one page of an event or tool output. UI only.', { id: { type: 'string' }, seq: { type: 'integer', minimum: 1 }, source: { type: 'string', enum: ['event', 'rawOutput', 'content'] }, offset: { type: 'integer', minimum: 0 } }],
    ['open_panel', 'Open Agent Dock to view and control shared local ACP subagents.', {}],
    ['agent_list', 'List persistent local ACP subagents shared across chats connected to this Agent Dock installation. On restart, saved sessions load through ACP and confirm model/effort before accepting input. Interrupted turns are not replayed; failed loads preserve history in error state. owner is a label, not access control.', {}],
    ['agent_spawn', 'Create an ACP session with independently selected provider, model and thoughtLevel. Defaults to the shared local working directory; an explicit worktreeRepo creates a branch and separate checkout from the repository HEAD.', { name: { type: 'string' }, owner: { type: 'string' }, provider: { type: 'string', enum: ['agy', 'claude'] }, worktreeRepo: { type: 'string', description: 'Opt-in absolute local Git repository path. Omit to use the default directory.' }, ...configProperties }],
    ['agent_configure', 'Change model, thoughtLevel or permissionMode on an idle session. Applies model first, then checks its updated reasoning options. Earlier confirmed changes can remain if a later option fails; read agent_get after an error.', { id: { type: 'string' }, ...configProperties }],
    ['agent_approve', 'Answer one pending ACP permission request. Inspect pendingPermissions in agent_get: tool input, locations, content and offered options. Select only an offered optionId within user-authorized scope; never automatically grant persistent permission. Omit optionId to cancel the request. Stale or invalid choices fail.', { id: { type: 'string' }, requestId: { type: 'string' }, optionId: { type: 'string' } }],
    ['agent_get', 'Get ACP agent status and streamed events after a cursor.', { id: { type: 'string' }, after: { type: 'integer', minimum: 0 } }],
    ['agent_send', 'Send a prompt asynchronously to an idle ACP session.', { id: { type: 'string' }, prompt: { type: 'string' } }],
    ['agent_wait', 'Wait up to 25 seconds for new ACP events or turn completion.', { id: { type: 'string' }, after: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 25000 } }],
    ['agent_cancel', 'Cancel the active ACP turn.', { id: { type: 'string' } }],
    ['agent_close', 'Archive an inactive ACP session and report local save, ACP close and process cleanup.', { id: { type: 'string' } }]
];
const server = new Server({ name: 'agent-dock', title: 'Agent Dock', version, icons }, { capabilities: { tools: {}, resources: {} } });
const panelTools = ['panel_sync', 'panel_detail'];
const hostLifetime = new AbortController();
let bridgeLease;

function attachBridge(local) {
    // Existing bridges keep working across an upgrade; they have no lease route.
    if (!local.managed) return;
    if (hostLifetime.signal.aborted) throw new Error('MCP host disconnected');
    if (bridgeLease?.url === local.url && bridgeLease.token === local.token) return bridgeLease.ready;
    bridgeLease?.request.destroy();
    const lease = { url: local.url, token: local.token };
    bridgeLease = lease;
    // A held loopback socket disappears even when the MCP process is killed.
    // Unlike UI polling, it stays attached when the panel is hidden.
    lease.ready = new Promise((resolve, reject) => {
        const req = httpRequest(local.url + '/lease', { headers: { Authorization: `Bearer ${local.token}` } }, (response) => {
            response.on('error', () => {});
            response.resume();
            if (response.statusCode === 200) {
                req.setTimeout(0);
                resolve();
            } else {
                req.destroy(new Error(`Bridge lease failed (${response.statusCode})`));
            }
        });
        lease.request = req;
        req.setTimeout(1500, () => req.destroy(new Error('Bridge lease timed out')));
        req.on('error', reject);
        req.once('close', () => {
            if (bridgeLease === lease) bridgeLease = undefined;
            reject(new Error('Bridge lease disconnected'));
        });
        req.end();
    });
    return lease.ready;
}

function disconnectHost() {
    hostLifetime.abort();
    bridgeLease?.request.destroy();
}

async function logHost(event) {
    await appendFile(path.join(stateRoot, 'work/evidence/mcp-hosts.jsonl'), JSON.stringify({ at: new Date().toISOString(), client: server.getClientVersion(), capabilities: server.getClientCapabilities(), event }) + '\n');
}

server.setRequestHandler(ListToolsRequestSchema, async function listTools() {
    await logHost('tools/list');
    return { tools: definitions.map(([name, description, properties]) => ({
        name, description,
        ...(name === 'open_panel' ? { title: 'Agent Dock', icons } : {}),
        inputSchema: { type: 'object', properties, additionalProperties: false, required: name === 'panel_sync' ? [] : name === 'panel_detail' ? ['id', 'seq', 'source'] : name === 'agent_send' ? ['id', 'prompt'] : name === 'agent_approve' ? ['id', 'requestId'] : 'id' in properties ? ['id'] : [] },
        annotations: { readOnlyHint: [...panelTools, 'open_panel', 'agent_list', 'agent_get', 'agent_wait'].includes(name), openWorldHint: true },
        _meta: name === 'open_panel' ? uiMetadata : { ui: { visibility: panelTools.includes(name) ? ['app'] : ['model', 'app'] } }
    })) };
});
server.setRequestHandler(ListResourcesRequestSchema, async function listResources() {
    return { resources: [{ uri, name: 'Agent Dock', mimeType: 'text/html;profile=mcp-app' }] };
});
server.setRequestHandler(ReadResourceRequestSchema, async function readResource(request) {
    if (request.params.uri !== uri) throw new Error('Unknown resource');
    await logHost('resources/read');
    return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: await readFile(path.join(root, 'panel.html'), 'utf8'), _meta: {
        ui: { prefersBorder: true },
        // Without this extension the host defaults to an inline result requiring manual expansion.
        'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'], preferredDisplayMode: 'fullscreen' }
    } }] };
});
server.setRequestHandler(CallToolRequestSchema, async function callTool(request) {
    if (!panelTools.includes(request.params.name)) await logHost(`tools/call:${request.params.name}`);
    try {
        const local = await ensureService();
        await attachBridge(local);
        const response = await fetch(local.url + '/tool', {
            method: 'POST', headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: request.params.name, arguments: request.params.arguments || {} }),
            signal: AbortSignal.any([hostLifetime.signal, AbortSignal.timeout(70000)])
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        return { content: [{ type: 'text', text: panelTools.includes(request.params.name) ? 'Panel data returned.' : JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
});
server.onclose = disconnectHost;
process.stdin.once('end', function hostEnded() {
    disconnectHost();
    void server.close();
});
await server.connect(new StdioServerTransport());
