import assert from 'node:assert/strict';
import { projectEvents, groupConsecutiveTools, thoughtOpenState, recoveryMessage } from './panel-view.mjs';
const events = [{seq:1,method:'bridge/prompt',params:{text:'sample'}},{seq:2,method:'session/update',params:{update:{sessionUpdate:'agent_thought_chunk',content:{text:'thinking'}}}}];
assert.equal(projectEvents(events)[1].streaming,true);
for (const status of ['completed', 'closed', 'idle', 'error', 'cancelled']) {
    assert.equal(projectEvents(events, { status, hasMore: true })[1].streaming, false);
    assert.equal(projectEvents(events, { status, hasMore: false })[1].streaming, false);
}
assert.equal(projectEvents(events, { status: 'running', hasMore: true })[1].streaming, false);
assert.equal(projectEvents(events, { status: 'running', hasMore: false })[1].streaming, true);
const reconnects = Array.from({ length: 6 }, (_, index) => ({ seq: index + 3, method: 'bridge/recovered', params: {} }));
assert.equal(projectEvents([...events, ...reconnects]).filter(item => item.type === 'notice').length, 0);
assert.equal(recoveryMessage(reconnects, undefined), undefined);
assert.equal(recoveryMessage(reconnects, 8), undefined);
assert.ok(recoveryMessage(reconnects, 2));
for (const params of [{ interrupted: true }, { recreated: true }]) {
    const important = { seq: 9, method: 'bridge/recovered', params };
    assert.equal(projectEvents([important])[0].type, 'notice');
    assert.equal(recoveryMessage([important], 8), undefined);
}
for (const terminal of [{method:'bridge/error',params:{message:'interrupted'}},{method:'bridge/turn_end',params:{stopReason:'cancelled'}},{method:'bridge/recovered',params:{interrupted:true}}]) {
    assert.equal(projectEvents([...events,{seq:3,...terminal}])[1].streaming,false);
}
assert.equal(thoughtOpenState(true),true);
assert.equal(thoughtOpenState(false),false);
assert.equal(thoughtOpenState(false,{streaming:true,open:true}),false);
assert.equal(thoughtOpenState(false,{streaming:false,open:true}),true);
assert.equal(thoughtOpenState(true,{streaming:true,open:false}),false);
const tool = (id,status='completed')=>({type:'tool',id,status,rawOutput:{output:`output-${id}`}});
const items=[tool('a'),tool('b','failed'),{type:'assistant',text:'reply'},tool('c'),{type:'notice',text:'approval'},tool('d'),tool('e','in_progress')];
const grouped=groupConsecutiveTools(items);
assert.deepEqual(grouped.map(item=>item.type),['tool-group','assistant','tool','notice','tool-group']);
assert.deepEqual(grouped.flatMap(item=>item.children||[item]),items);
assert.equal(grouped[0].id,groupConsecutiveTools([tool('a'),tool('b'),tool('new')])[0].id);
assert.equal(grouped[0].children[1].status,'failed');
console.log(JSON.stringify({passed:true,thoughtSettlesOnErrorCancelRecovery:true,autoCollapseOnce:true,manualStatePreserved:true,consecutiveToolsGrouped:true,chronologyAndOutputsPreserved:true,stableGroupId:true}));
