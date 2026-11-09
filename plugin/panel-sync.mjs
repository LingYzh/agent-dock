import { createHash } from 'node:crypto';
import { usageSummary } from './usage.mjs';
import { compactPanelEvent } from './panel-detail.mjs';

const maxEvents = 200;
const maxBytes = 256 * 1024;
const summaries = new WeakMap();

function recentPage(events, end, project) {
    let start = end;
    let bytes = 0;
    while (start > 0 && end - start < maxEvents) {
        const size = Buffer.byteLength(JSON.stringify(project(events[start - 1])));
        if (start < end && bytes + size > maxBytes) break;
        start--;
        bytes += size;
    }
    // Prefer a prompt boundary, but still page through a single very long turn.
    const boundary = events.slice(start, end).findIndex((event) => event.method === 'bridge/prompt');
    if (start > 0 && boundary > 0) start += boundary;
    return { startCursor: start, cursor: end, events: events.slice(start, end).map(project) };
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
        return { ...response, agent: { id: agent.id, ...recentPage(agent.events, args.before, project) } };
    }
    if (args.after === cursor && args.status === agent.status) return response;
    const validAfter = Number.isInteger(args.after) && args.after >= 0 && args.after <= cursor;
    const after = validAfter ? args.after : 0;
    const events = [];
    let bytes = 0;
    const latest = args.recent && !validAfter ? recentPage(agent.events, cursor, project) : null;
    for (let index = after; !latest && index < cursor && events.length < maxEvents; index++) {
        const event = project(agent.events[index]);
        const size = Buffer.byteLength(JSON.stringify(event));
        // An individual event must remain intact, even if it exceeds the page budget.
        if (events.length && bytes + size > maxBytes) break;
        events.push(event);
        bytes += size;
    }
    const next = latest?.cursor ?? events.at(-1)?.seq ?? after;
    response.agent = {
        id: agent.id, name: agent.name, provider: agent.provider || 'agy', status: agent.status,
        sessionId: agent.sessionId, cwd: agent.cwd, worktree: agent.worktree, archive: agent.archive, info: { protocolVersion: agent.info?.protocolVersion },
        configOptions: agent.configOptions, availableCommands: (agent.availableCommands || []).map(({ name }) => ({ name })),
        contextUsage: agent.contextUsage, pendingPermissions: agent.client?.permissionSnapshots() || [],
        error: agent.error, result: agent.result, events: latest?.events ?? events, cursor: next, sourceCursor: cursor, hasMore: next < cursor,
        ...(args.recent ? { startCursor: latest?.startCursor ?? after, usage: fullUsage(agent) } : {}),
        ...(args.compact ? { detailAvailable: true } : {}),
        replace: after !== args.after
    };
    return response;
}
