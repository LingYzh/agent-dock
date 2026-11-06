import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFile, appendFile, mkdir } from 'node:fs/promises';
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
    ['panel_sync', 'Incremental read-only panel synchronization. UI only.', { id: { type: 'string' }, after: { type: 'integer', minimum: 0 }, status: { type: 'string' }, revision: { type: 'string' } }],
    ['open_panel', 'Open Agent Dock to view and control shared local ACP subagents.', {}],
    ['agent_list', 'List persistent local ACP subagents shared across chats connected to this Agent Dock installation. On restart, saved sessions load through ACP and confirm model/effort before accepting input. Interrupted turns are not replayed; failed loads preserve history in error state. owner is a label, not access control.', {}],
    ['agent_spawn', 'Create an ACP session with independently selected provider, model and thoughtLevel. Confirmed configOptions are returned. Omitted values use provider defaults. E-drive test directory, not a sandbox.', { name: { type: 'string' }, owner: { type: 'string' }, provider: { type: 'string', enum: ['agy', 'claude'] }, ...configProperties }],
    ['agent_configure', 'Change model, thoughtLevel or permissionMode on an idle session. Applies model first, then checks its updated reasoning options. Earlier confirmed changes can remain if a later option fails; read agent_get after an error.', { id: { type: 'string' }, ...configProperties }],
    ['agent_approve', 'Answer one pending ACP permission request. Inspect pendingPermissions in agent_get: tool input, locations, content and offered options. Select only an offered optionId within user-authorized scope; never automatically grant persistent permission. Omit optionId to cancel the request. Stale or invalid choices fail.', { id: { type: 'string' }, requestId: { type: 'string' }, optionId: { type: 'string' } }],
    ['agent_get', 'Get ACP agent status and streamed events after a cursor.', { id: { type: 'string' }, after: { type: 'integer', minimum: 0 } }],
    ['agent_send', 'Send a prompt asynchronously to an idle ACP session.', { id: { type: 'string' }, prompt: { type: 'string' } }],
    ['agent_wait', 'Wait up to 25 seconds for new ACP events or turn completion.', { id: { type: 'string' }, after: { type: 'integer', minimum: 0 }, timeoutMs: { type: 'integer', minimum: 0, maximum: 25000 } }],
    ['agent_cancel', 'Cancel the active ACP turn.', { id: { type: 'string' } }],
    ['agent_close', 'Close an idle ACP session and release its process.', { id: { type: 'string' } }]
];
const server = new Server({ name: 'agent-dock', title: 'Agent Dock', version, icons }, { capabilities: { tools: {}, resources: {} } });

async function logHost(event) {
    await appendFile(path.join(stateRoot, 'work/evidence/mcp-hosts.jsonl'), JSON.stringify({ at: new Date().toISOString(), client: server.getClientVersion(), capabilities: server.getClientCapabilities(), event }) + '\n');
}

server.setRequestHandler(ListToolsRequestSchema, async function listTools() {
    await logHost('tools/list');
    return { tools: definitions.map(([name, description, properties]) => ({
        name, description,
        ...(name === 'open_panel' ? { title: 'Agent Dock', icons } : {}),
        inputSchema: { type: 'object', properties, additionalProperties: false, required: name === 'panel_sync' ? [] : name === 'agent_send' ? ['id', 'prompt'] : name === 'agent_approve' ? ['id', 'requestId'] : 'id' in properties ? ['id'] : [] },
        annotations: { readOnlyHint: ['panel_sync', 'open_panel', 'agent_list', 'agent_get', 'agent_wait'].includes(name), openWorldHint: true },
        _meta: name === 'open_panel' ? uiMetadata : { ui: { visibility: name === 'panel_sync' ? ['app'] : ['model', 'app'] } }
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
    if (request.params.name !== 'panel_sync') await logHost(`tools/call:${request.params.name}`);
    try {
        const local = await ensureService();
        const response = await fetch(local.url + '/tool', {
            method: 'POST', headers: { Authorization: `Bearer ${local.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: request.params.name, arguments: request.params.arguments || {} }),
            signal: AbortSignal.timeout(70000)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        return { content: [{ type: 'text', text: request.params.name === 'panel_sync' ? 'Panel synchronized.' : JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
        return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
});
await server.connect(new StdioServerTransport());
