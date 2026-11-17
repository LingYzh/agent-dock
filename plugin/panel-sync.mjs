import { createHash } from 'node:crypto';
import { usageSummary } from './usage.mjs';
import { compactPanelEvent } from './panel-detail.mjs';

const maxEvents = 200;
const maxBytes = 256 * 1024;
const summaries = new WeakMap();

function projectPage(source, start, end, project, compact) {
    const events = source.slice(start, end).map(project);
    if (!compact) return events;
    const fields = ['title', 'name', 'kind'];
    const contexts = new Map();
    const missing = new Set();
    const seen = new Set();
    function metadata(update) {
        const result = {};
        for (const field of fields) {
            if (typeof update[field] !== 'string') continue;
            const text = update[field].slice(0, 512);
            result[field] = /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
        }
        return result;
    }
    for (const event of events) {
        const update = event.params?.update;
        if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) || seen.has(update.toolCallId)) continue;
        seen.add(update.toolCallId);
        if (update.sessionUpdate === 'tool_call_update' && ((!update.title && !update.name) || !update.kind)) {
            missing.add(update.toolCallId);
            contexts.set(update.toolCallId, {});
        }
    }
    // A recent/backwards window can begin after a tool's initial event. Recover
    // only its actual label/type; outputs, status and detail references stay at
    // their original sequence. One shared prefix scan serves all visible tools.
    for (let index = start - 1; index >= 0 && missing.size; index--) {
        const update = source[index].params?.update;
        if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) || !missing.has(update.toolCallId)) continue;
        const context = contexts.get(update.toolCallId);
        for (const [field, value] of Object.entries(metadata(update))) context[field] ??= value;
        if (update.sessionUpdate === 'tool_call' || ((context.title || context.name) && context.kind)) missing.delete(update.toolCallId);
    }
    return events.map((event) => {
        const update = event.params?.update;
        if (!['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) return event;
        const context = { ...contexts.get(update.toolCallId), ...metadata(update) };
        contexts.set(update.toolCallId, context);
        if (!fields.some(field => update[field] === undefined && context[field] !== undefined)) return event;
        return { ...event, params: { ...event.params, update: { ...context, ...update } } };
    });
}

function recentPage(events, end, project, compact) {
    const first = Math.max(0, end - maxEvents);
    const candidates = projectPage(events, first, end, project, compact);
    let offset = candidates.length;
    let bytes = 0;
    while (offset > 0) {
        const size = Buffer.byteLength(JSON.stringify(candidates[offset - 1]));
        if (offset < candidates.length && bytes + size > maxBytes) break;
        offset--;
        bytes += size;
    }
    // Prefer a prompt boundary, but still page through a single very long turn.
    const boundary = candidates.slice(offset).findIndex((event) => event.method === 'bridge/prompt');
    if (first + offset > 0 && boundary > 0) offset += boundary;
    return { startCursor: first + offset, cursor: end, events: candidates.slice(offset) };
}

function fullUsage(agent) {
    const cached = summaries.get(agent);
    const cursor = agent.events.length;
    if (cached?.cursor === cursor && cached.context === agent.contextUsage && cached.commands === agent.availableCommands) return cached.summary;
    const summary = usageSummary(agent);
    summaries.set(agent, { cursor, context: agent.contextUsage, commands: agent.availableCommands, summary });
    return summary;
}

// Older panels keep their forward-only wire contract. New panels request a recent
// window once and use a separate backwards cursor when the reader asks for history.
export function panelSync(registry, args = {}) {
    const agents = [...registry.values()].map((agent) => ({ id: agent.id, name: agent.name, provider: agent.provider || 'agy', status: agent.status, cursor: agent.events.length }));
    const revision = createHash('sha256').update(JSON.stringify(agents)).digest('hex').slice(0, 16);
    const response = { revision };
    if (args.revision !== revision) response.agents = agents;
    const agent = registry.get(args.id);
    if (!agent) return response;
    const cursor = agent.events.length;
    const project = args.compact ? compactPanelEvent : (event) => event;
    if (args.recent && Number.isInteger(args.before) && args.before > 0 && args.before <= cursor) {
        return { ...response, agent: { id: agent.id, ...recentPage(agent.events, args.before, project, args.compact) } };
    }
    if (args.after === cursor && args.status === agent.status) return response;
    const validAfter = Number.isInteger(args.after) && args.after >= 0 && args.after <= cursor;
    const after = validAfter ? args.after : 0;
    const events = [];
    let bytes = 0;
    let latest = args.recent && !validAfter ? recentPage(agent.events, cursor, project, args.compact) : null;
    const forward = latest ? [] : projectPage(agent.events, after, Math.min(cursor, after + maxEvents), project, args.compact);
    for (const event of forward) {
        const size = Buffer.byteLength(JSON.stringify(event));
        // An individual event must remain intact, even if it exceeds the page budget.
        if (events.length && bytes + size > maxBytes) break;
        events.push(event);
        bytes += size;
    }
    // Live views must not replay a large backlog one page at a time. Reset to
    // the tail if the missed updates exceed either one page's event or byte cap.
    if (args.recent && !latest && (events.at(-1)?.seq ?? after) < cursor) latest = recentPage(agent.events, cursor, project, args.compact);
    const next = latest?.cursor ?? events.at(-1)?.seq ?? after;
    response.agent = {
        id: agent.id, name: agent.name, provider: agent.provider || 'agy', status: agent.status,
        sessionId: agent.sessionId, cwd: agent.cwd, worktree: agent.worktree, archive: agent.archive, info: { protocolVersion: agent.info?.protocolVersion },
        configOptions: agent.configOptions, availableCommands: (agent.availableCommands || []).map(({ name }) => ({ name })),
        contextUsage: agent.contextUsage, pendingPermissions: agent.client?.permissionSnapshots() || [],
        error: agent.error, result: agent.result, events: latest?.events ?? events, cursor: next, sourceCursor: cursor, hasMore: next < cursor,
        ...(args.recent ? { startCursor: latest?.startCursor ?? after, usage: fullUsage(agent) } : {}),
        ...(args.compact ? { detailAvailable: true } : {}),
        replace: Boolean(latest) || after !== args.after
    };
    return response;
}
