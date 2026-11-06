import { createHash } from 'node:crypto';

// The app polls this compact endpoint, never the model-facing full snapshots.
// Unchanged polls contain only a revision; history is paged once, then appended.
export function panelSync(registry, args = {}) {
    const agents = [...registry.values()].map((agent) => ({ id: agent.id, name: agent.name, provider: agent.provider || 'agy', status: agent.status, cursor: agent.events.length }));
    const revision = createHash('sha256').update(JSON.stringify(agents)).digest('hex').slice(0, 16);
    const response = { revision };
    if (args.revision !== revision) response.agents = agents;
    const agent = registry.get(args.id);
    if (!agent) return response;
    const cursor = agent.events.length;
    if (args.after === cursor && args.status === agent.status) return response;
    const after = Number.isInteger(args.after) && args.after >= 0 && args.after <= cursor ? args.after : 0;
    const events = [];
    let bytes = 0;
    for (let index = after; index < cursor && events.length < 200; index++) {
        const event = agent.events[index];
        const size = Buffer.byteLength(JSON.stringify(event));
        // An individual event must remain intact, even if it exceeds the page budget.
        if (events.length && bytes + size > 256 * 1024) break;
        events.push(event);
        bytes += size;
    }
    const next = events.at(-1)?.seq ?? after;
    response.agent = {
        id: agent.id, name: agent.name, provider: agent.provider || 'agy', status: agent.status,
        sessionId: agent.sessionId, cwd: agent.cwd, info: { protocolVersion: agent.info?.protocolVersion },
        configOptions: agent.configOptions, availableCommands: (agent.availableCommands || []).map(({ name }) => ({ name })),
        contextUsage: agent.contextUsage, pendingPermissions: agent.client?.permissionSnapshots() || [],
        error: agent.error, result: agent.result, events, cursor: next, sourceCursor: cursor, hasMore: next < cursor,
        replace: after !== args.after
    };
    return response;
}
