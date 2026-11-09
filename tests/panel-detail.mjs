import assert from 'node:assert/strict';
import { panelSync } from '../plugin/panel-sync.mjs';
import { panelDetail } from '../plugin/panel-detail.mjs';
import { projectEvents, toolPreview } from '../plugin/panel-view.mjs';

const output = 'A' + '🙂'.repeat(145000) + '\nend';
const input = { secretFixture: 'x'.repeat(360000) };
const diff = { type: 'diff', path: 'fixture.txt', oldText: 'before', newText: '改'.repeat(200000) };
function event(seq, update) { return { seq, method: 'session/update', params: { sessionId: 'native', update } }; }
const events = [
    event(1, { sessionUpdate: 'tool_call', toolCallId: 'command', kind: 'execute', title: 'Read output', rawInput: input }),
    event(2, { sessionUpdate: 'tool_call_update', toolCallId: 'command', rawOutput: { output } }),
    event(3, { sessionUpdate: 'tool_call_update', toolCallId: 'command', status: 'completed' }),
    event(4, { sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', content: [diff] })
];
const agent = { id: 'dock', status: 'closed', events };
const registry = new Map([[agent.id, agent]]);
const result = panelSync(registry, { id: agent.id, recent: true, compact: true });
assert.ok(Buffer.byteLength(JSON.stringify(result)) < 20000, 'Large tool updates must not exceed the ordinary wire budget');
assert.equal(result.agent.events.length, 4);
assert.equal(result.agent.detailAvailable, true);
assert.equal(result.agent.events[0].params.update.rawInput, undefined);
assert.equal(events[0].params.update.rawInput, input);
assert.equal(events[1].params.update.rawOutput.output, output);
const [command, edit] = projectEvents(result.agent.events, result.agent);
assert.equal(command.status, 'completed');
assert.deepEqual(toolPreview(command).ref, { seq: 2, source: 'rawOutput', length: output.length });
assert.equal(toolPreview(edit).ref.source, 'content');
assert.equal(panelSync(registry, { id: agent.id, recent: true, compact: true, before: 3 }).agent.events.length, 3);

function read(seq, source) {
    let offset = 0;
    let text = '';
    do {
        const page = panelDetail(agent, { seq, source, offset });
        assert.ok(page.text.length <= 24 * 1024);
        assert.ok(!/[\uD800-\uDBFF]$/.test(page.text), 'A page cannot end in a split surrogate pair');
        text += page.text;
        offset = page.next;
    } while (offset !== null);
    return text;
}
assert.equal(read(2, 'rawOutput'), output);
assert.ok(read(4, 'content').includes(diff.newText));
assert.deepEqual(JSON.parse(read(1, 'event')), events[0]);
assert.throws(() => panelDetail(agent, { seq: 5, source: 'event' }), /Unknown session event/);
assert.throws(() => panelDetail(agent, { seq: 2, source: 'rawOutput', offset: 2 }), /Invalid detail offset/);
const legacy = panelSync(registry, { id: agent.id });
assert.equal(legacy.agent.events[0].params.update.rawInput, input);
console.log(JSON.stringify({ passed: true, compactForwardAndBackward: true, rawUnchanged: true, completeOutputInPages: true, unicodeBoundary: true, legacySync: true }));
