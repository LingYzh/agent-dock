import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { AcpClient } from './acp.mjs';
import { configureSession } from './session-config.mjs';
import { tokenComposition } from './usage.mjs';

const fake = `
import { createInterface } from 'node:readline';
let prompt;
let results = [];
function send(value) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n'); }
createInterface({ input: process.stdin }).on('line', function receive(line) {
    const message = JSON.parse(line);
    if (message.method === 'session/prompt') {
        prompt = message;
        results = [];
        for (const id of [101, 102]) send({ id, method: 'session/request_permission', params: { sessionId: 'test', id: 'untrusted-id', toolCall: { toolCallId: String(id), title: '<b>Untrusted title</b>' }, options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Deny' }] } });
    } else if (message.result) {
        results.push(message.result.outcome);
        if (results.length === 2) send({ id: prompt.id, result: { stopReason: 'end_turn', outcomes: results } });
    }
});`;
const client = new AcpClient(process.execPath, process.cwd(), function ignore() {}, { args: ['--input-type=module', '-e', fake], onPermission: function ignore() {} });
async function waitPending() {
    const deadline = Date.now() + 3000;
    while (client.permissions.size !== 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(client.permissions.size, 2);
    return client.permissionSnapshots();
}
try {
    const turn = client.request('session/prompt', {}, 500);
    const pending = await waitPending();
    assert.notEqual(pending[0].id, 'untrusted-id');
    assert.throws(() => client.resolvePermission(pending[0].id, 'invented'), /not offered/);
    assert.equal(client.permissions.size, 2);
    // A human may take longer than the model-turn timeout to review a request.
    await new Promise((resolve) => setTimeout(resolve, 600));
    client.resolvePermission(pending[0].id, 'yes');
    assert.equal([...client.pending.values()][0].timer, null, 'Second outstanding approval keeps the prompt clock paused');
    assert.throws(() => client.resolvePermission(pending[0].id, 'yes'), /no longer pending/);
    client.resolvePermission(pending[1].id, 'no');
    assert.deepEqual((await turn).outcomes, [{ outcome: 'selected', optionId: 'yes' }, { outcome: 'selected', optionId: 'no' }]);

    const cancelled = client.request('session/prompt', {}, 1000);
    await waitPending();
    client.notify('session/cancel', { sessionId: 'test' });
    assert.deepEqual((await cancelled).outcomes, [{ outcome: 'cancelled' }, { outcome: 'cancelled' }]);

    const requestCancelled = client.request('session/prompt', {}, 1000);
    const again = await waitPending();
    client.receive(JSON.stringify({ method: '$/cancel_request', params: { requestId: 101 } }));
    client.resolvePermission(again[1].id, 'no');
    assert.deepEqual((await requestCancelled).outcomes, [{ outcome: 'cancelled' }, { outcome: 'selected', optionId: 'no' }]);

    const broken = client.request('session/prompt', {}, 1000);
    const rejected = assert.rejects(broken, /exited/);
    await waitPending();
    client.process.kill();
    await rejected;
    assert.equal(client.permissions.size, 0);
} finally { client.stop(); }

const calls = [];
const config = { sessionId: 'config-test', configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'old', options: [] }], client: {
    async request(method, params) {
        calls.push({ method, ...params });
        return { configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'flash', options: [] }, { id: 'effort', category: 'thought_level', type: 'select', currentValue: params.configId === 'effort' ? params.value : 'high', options: [{ value: 'low' }, { value: 'high' }] }] };
    }
} };
await configureSession(config, { model: 'flash', thoughtLevel: 'low' });
assert.deepEqual(calls.map((item) => [item.configId, item.value]), [['model', 'flash'], ['effort', 'low']]);
await assert.rejects(configureSession(config, { thoughtLevel: 'invented' }), /Unsupported thoughtLevel/);
assert.equal(calls.length, 2);
const composition = tokenComposition({ inputTokens: 100, outputTokens: 20, thoughtTokens: 10, cachedReadTokens: 80, cachedWriteTokens: 0 });
assert.equal(composition.total, 200);
assert.equal(composition.segments.reduce((sum, item) => sum + item.percent, 0), 100);
assert.equal(tokenComposition({}).segments.length, 0);
assert.equal(tokenComposition({ inputTokens: 0 }).segments[0].value, 0);
const result = { passed: true, scope: 'Local synthetic ACP stdio transport, not real upstream or Codex host acceptance', queuedRequests: 2, allowAndDeny: true, staleAndInvalidOptionsRejected: true, approvalWaitExcludedFromPromptTimeout: true, cancelAll: true, cancelRequest: true, transportFailureCleanup: true, reasoningCatalogAfterModel: true, thoughtTokensNotDoubleCounted: true };
await writeFile(new URL('work/evidence/permissions-unit.json', import.meta.url), JSON.stringify(result, null, 4));
console.log(JSON.stringify(result));
