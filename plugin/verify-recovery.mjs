import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SessionStore, applySessionEvent } from './session-store.mjs';
import { restoreSession } from './session-recovery.mjs';
import { projectEvents } from './panel-view.mjs';
import { AcpSessionPool } from './acp-pool.mjs';

const directory = mkdtempSync(new URL('work/recovery-test-', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const store = new SessionStore(directory);
const config = [{ id: 'model', category: 'model', type: 'select', currentValue: 'gemini-3.8-flash' }, { id: 'thought_level', category: 'thought_level', type: 'select', currentValue: 'low', options: [{value:'low'}] }, {id:'mode', category:'mode', type:'select', currentValue:'default', options:[{value:'default'}]}];
const initial = { id: randomUUID(), name: 'persisted', provider: 'agy', owner: 'original-owner', status: 'idle', sessionId: 'original-session', cwd: directory, configOptions: config, events: [], client: { secret: 'not-persisted' }, pendingPermissions: [{id:'stale'}] };
store.checkpoint(initial);
initial.status = 'blocked';
const event = {seq:1, method:'bridge/prompt', params:{text:'do not repeat'}, at:'test'};
applySessionEvent(initial, event);
store.append(initial, event);
appendFileSync(store.file(initial.id), '{"event":');
const saved = store.load()[0];
assert.equal(saved.status, 'blocked');
assert.equal(saved.owner, 'original-owner');
assert.deepEqual(saved.events, [event]);
assert.equal(saved.client, undefined);
assert.equal(saved.pendingPermissions, undefined);
assert.ok(!readFileSync(store.file(initial.id), 'utf8').includes('not-persisted'));

function recording(agent, method, params) {
    const event = { seq: agent.events.length + 1, method, params };
    applySessionEvent(agent, event);
    store.append(agent, event);
}
function fakeClient({ missing = false, unsupported = false, mismatch = false } = {}) {
    const calls = [];
    const options = structuredClone(config);
    options[0].currentValue = 'gemini-4-argon';
    return { calls, stopped:false, async request(method, args) {
        calls.push({method,args});
        if (method === 'initialize') return {agentCapabilities:{loadSession:!unsupported}};
        if (method === 'session/load' && missing) throw new Error(JSON.stringify({code:-32002,message:'Resource not found'}));
        if (method === 'session/load' || method === 'session/new') return {sessionId:'new-empty',configOptions:options};
        if (method === 'session/set_config_option') {
            if (!mismatch) options.find((option)=>option.id===args.configId).currentValue = args.value;
            return {configOptions:options};
        }
        throw new Error(`Unexpected method ${method}`);
    }, stop() { this.stopped = true; } };
}
const client = fakeClient();
await restoreSession(saved, () => client, recording);
assert.equal(saved.status, 'cancelled');
assert.equal(saved.sessionId, 'original-session');
assert.equal(saved.configOptions[0].currentValue, 'gemini-3.8-flash');
assert.equal(saved.configOptions[1].currentValue, 'low');
assert.ok(saved.recovery.interrupted);
assert.equal(saved.events.filter((event)=>event.method==='bridge/prompt').length, 1);
assert.ok(!client.calls.some(({method})=>['session/prompt','session/request_permission'].includes(method)));
assert.ok(projectEvents(saved.events).some((item)=>item.text?.includes('不会自动重发')));
store.checkpoint(saved);
assert.equal(store.load()[0].status, 'cancelled');

const creating = { ...structuredClone({...initial,client:undefined}), id:randomUUID(), status:'starting', events:[], configOptions:[{...config[0],currentValue:'gemini-4-argon'}], recovery:{phase:'creating',previousStatus:'idle',requested:{model:'gemini-3.8-flash',thoughtLevel:'low'}} };
store.checkpoint(creating);
await restoreSession(creating, () => fakeClient(), recording);
assert.equal(creating.status, 'idle');
assert.equal(creating.configOptions[0].currentValue, 'gemini-3.8-flash');

for (const [label, setup, expected] of [
    ['closed-history-missing', {missing:true,history:true}, 'error'],
    ['empty-claude', {missing:true,history:false}, 'idle'],
    ['unsupported', {unsupported:true,history:false}, 'error'],
    ['model-mismatch', {mismatch:true,history:false}, 'error']
]) {
    const agent = {...structuredClone({...initial,client:undefined}), id:randomUUID(), provider:'claude', status:'idle', events:setup.history?[event]:[]};
    store.checkpoint(agent);
    const fake = fakeClient(setup);
    await restoreSession(agent, () => fake, recording);
    assert.equal(agent.status, expected, label);
    assert.equal(fake.calls.some(({method})=>method==='session/new'), label==='empty-claude');
    assert.equal(fake.calls.some(({method})=>method==='session/prompt'), false);
    if (expected === 'error') assert.ok(fake.stopped);
}
// Real JSON-RPC framing through one shared process: a recreated Claude session
// must stop receiving updates addressed to its previous native ID.
const peer = `
    import { createInterface } from 'node:readline';
    function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
    createInterface({ input: process.stdin }).on('line', (line) => {
        const { id, method, params } = JSON.parse(line);
        if (method === 'initialize') send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
        if (method === 'session/load') {
            if (params.sessionId === 'missing') send({ id, error: { code: -32002, message: 'Resource not found' } });
            else send({ id, result: { configOptions: [] } });
        }
        if (method === 'session/new') send({ id, result: { sessionId: 'replacement', configOptions: [] } });
        if (method === 'session/set_config_option') {
            for (const sessionId of ['missing', params.sessionId]) send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [] } } });
            send({ id, result: { configOptions: [] } });
        }
        if (method === 'session/close') send({ id, result: {} });
    });
`;
const pool = new AcpSessionPool({ command: process.execPath, args: ['--input-type=module', '-e', peer] }, directory);
const observed = new Map();
function acquire(agent) {
    const updates = [];
    observed.set(agent.id, updates);
    return pool.acquire({
        onEvent(method, params) { updates.push(params.sessionId); },
        onPermission() { assert.fail('Unexpected fixture permission'); },
        onDisconnect() { assert.fail('Unexpected fixture disconnect'); }
    });
}
try {
    const [missing, sibling] = ['missing', 'sibling'].map((sessionId) => ({
        id: randomUUID(), provider: 'claude', cwd: directory, status: 'idle', sessionId, events: []
    }));
    for (const agent of [missing, sibling]) store.checkpoint(agent);
    await Promise.all([missing, sibling].map((agent) => restoreSession(agent, acquire, recording)));
    assert.equal(missing.sessionId, 'replacement');
    assert.equal(sibling.sessionId, 'sibling');
    await sibling.client.request('session/set_config_option', { sessionId: sibling.sessionId, configId: 'mode', value: 'default' });
    assert.deepEqual(observed.get(missing.id), []);
    assert.deepEqual(observed.get(sibling.id), ['sibling']);
    await missing.client.stop();
    await sibling.client.request('session/set_config_option', { sessionId: sibling.sessionId, configId: 'mode', value: 'default' });
    await sibling.client.stop();
} finally { pool.stop(); }
console.log(JSON.stringify({passed:true, checks:['flushed journal and torn tail','owner/history/cursor persistence','stale approvals removed','interrupted turn not replayed','model/effort reconfirmed','empty Claude only recreation','history missing preserved as error','unsupported/mismatch fail closed','shared Claude rebind drops old ID'], promptsSent:0}));
