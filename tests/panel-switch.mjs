import assert from 'node:assert/strict';
import { panelSync } from '../plugin/panel-sync.mjs';
import { createPanelCache, mergePanelState, panelSyncArgs } from '../plugin/panel-state.mjs';
import { projectEvents } from '../plugin/panel-view.mjs';
import { panelDetail } from '../plugin/panel-detail.mjs';

function transcript(id, turns, size = 30) {
    const events = [];
    for (let turn = 0; turn < turns; turn++) {
        events.push(
            { seq: events.length + 1, method: 'bridge/prompt', params: { text: `${id} prompt ${turn}` } },
            { seq: events.length + 2, method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: `${id} reply ${turn} ` + '字'.repeat(size) } } } },
            { seq: events.length + 3, method: 'bridge/turn_end', params: { stopReason: 'end_turn' } }
        );
    }
    return { id, name: id, status: 'completed', events };
}

const agents = ['a', 'b', 'c'].map(id => transcript(id, 1200));
const registry = new Map(agents.map(agent => [agent.id, agent]));
const cache = createPanelCache();
for (const agent of agents) {
    const response = panelSync(registry, panelSyncArgs(undefined, agent.id));
    assert.equal(response.agent.cursor, agent.events.length);
    assert.equal(response.agent.hasMore, false);
    assert.ok(response.agent.startCursor > 0 && response.agent.events.length <= 200);
    cache.remember(response.agent);
}
const cached = cache.get('a');
assert.ok(cached.events.length > 0 && cached.events.length <= 200);
const selected = panelSyncArgs(cached, 'a', undefined, false, true);
assert.equal(selected.after, undefined, 'Switching revalidates the tail instead of replaying missed pages');
assert.equal(selected.status, undefined);
assert.equal(panelSync(registry, selected).agent.cursor, agents[0].events.length);

const stale = { ...cached, cursor: 100, events: agents[0].events.slice(0, 100), startCursor: 0 };
const latest = panelSync(registry, panelSyncArgs(stale, 'a')).agent;
assert.equal(latest.cursor, agents[0].events.length);
assert.equal(latest.hasMore, false);
assert.equal(latest.replace, true);
assert.equal(mergePanelState(stale, latest), latest, 'A reset cannot concatenate a gap into old history');
assert.equal(panelSync(registry, { id: 'a', after: 100 }).agent.cursor, 300, 'Legacy forward paging remains unchanged');

const large = transcript('large', 40, 6000);
registry.set(large.id, large);
const byteLimited = panelSync(registry, { id: large.id, after: 0, recent: true }).agent;
assert.equal(byteLimited.cursor, large.events.length);
assert.equal(byteLimited.hasMore, false);
assert.ok(byteLimited.startCursor > 0, 'The byte budget can require a tail reset even below 200 events');

cache.remember({ ...large, startCursor: 0, cursor: large.events.length, sourceCursor: large.events.length, pendingPermissions: [{ payload: 'not cached' }] });
const bounded = cache.get(large.id);
assert.ok(new TextEncoder().encode(JSON.stringify(bounded)).length <= 256 * 1024);
assert.deepEqual(bounded.pendingPermissions, [], 'An old approval is never actionable from the cache');
assert.equal(bounded.startCursor, bounded.events[0].seq - 1);
cache.remember({ ...cached, id: 'fifth' });
assert.equal(cache.get('b'), undefined, 'Only four recently used windows are retained');
cache.remember({ ...cached, id: 'partial', hasMore: true });
assert.equal(cache.get('partial'), undefined, 'Incomplete catch-up pages are not cached');

const toolEvents = [
    { seq: 1, method: 'bridge/prompt', params: { text: 'A tool longer than one visible window' } },
    { seq: 2, method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'across-pages', title: 'Initial tool label', kind: 'read', status: 'in_progress' } } }
];
const rawOutput = 'RAW_START' + '😀'.repeat(50000) + 'RAW_END';
for (let index = 0; index < 250; index++) {
    toolEvents.push({ seq: toolEvents.length + 1, method: 'session/update', params: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'across-pages', status: index === 249 ? 'completed' : 'in_progress', ...(index === 100 ? { title: 'Updated tool label' } : {}), ...(index === 200 ? { kind: 'edit' } : {}), rawOutput: { output: index === 249 ? rawOutput : `progress ${index}` } } } });
}
const toolAgent = { id: 'tool-boundary', status: 'completed', events: toolEvents };
registry.set(toolAgent.id, toolAgent);
const toolPage = panelSync(registry, { id: toolAgent.id, recent: true, compact: true }).agent;
assert.ok(toolPage.startCursor > 2);
assert.equal(toolPage.events[0].params.update.title, 'Initial tool label');
const projectedTool = projectEvents(toolPage.events, toolPage).find(item => item.type === 'tool');
assert.equal(projectedTool.title, 'Updated tool label');
assert.equal(projectedTool.kind, 'edit');
assert.equal(projectedTool.status, 'completed');
assert.equal(projectedTool.panelRawOutput.ref.seq, toolEvents.length);
assert.ok(panelDetail(toolAgent, projectedTool.panelRawOutput.ref).text.startsWith('RAW_START'));
const earlier = panelSync(registry, { id: toolAgent.id, before: toolPage.startCursor, recent: true, compact: true }).agent;
assert.equal(projectEvents(earlier.events, earlier).find(item => item.type === 'tool').title, 'Initial tool label', 'Later metadata must not leak into an earlier page');
cache.remember(toolPage);
assert.equal(projectEvents(cache.get(toolAgent.id).events).find(item => item.type === 'tool').title, 'Updated tool label');
assert.equal(toolEvents[249].params.update.title, undefined, 'Projected context must not mutate raw events');
assert.equal(toolEvents[249].params.update.kind, undefined);
console.log(JSON.stringify({ passed: true, sessions: 3, eventsPerSession: 3600, latestOnEverySelection: true, backlogResetsToTail: true, byteLimitedBacklog: true, cacheEventAndByteCaps: true, staleApprovalsExcluded: true, legacyPagingPreserved: true, crossPageToolMetadata: true, rawDetailRefsPreserved: true }));
