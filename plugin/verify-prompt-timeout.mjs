import assert from 'node:assert/strict';
import { AcpClient } from './acp.mjs';
const fake = `
import { createInterface } from 'node:readline';
function send(value) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n'); }
createInterface({input:process.stdin}).on('line', (message) => {
    const req = JSON.parse(message);
    if (req.method === 'initialize') return send({id:req.id,result:{}});
    if (req.params.mode === 'silent') return;
    let updates=0;
    const timer=setInterval(() => {
        send({method:'session/update',params:{sessionId:req.params.mode==='other'?'unrelated':req.params.sessionId,update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'progress'}}}});
        if (++updates === 5) { clearInterval(timer); send({id:req.id,result:{stopReason:'end_turn'}}); }
    },70);
});`;
const client = new AcpClient(process.execPath, process.cwd(), () => {}, {args:['--input-type=module','-e',fake]});
try {
    // Wait for the fixture process so the short deadline measures prompt silence.
    await client.request('initialize', {}, 5000);
    const started = Date.now();
    assert.equal((await client.request('session/prompt',{sessionId:'streaming'},180)).stopReason,'end_turn');
    assert.ok(Date.now()-started > 180);
    await assert.rejects(client.request('session/prompt',{sessionId:'silent',mode:'silent'},120), /ACP timeout/);
    await assert.rejects(client.request('session/prompt',{sessionId:'wanted',mode:'other'},180), /ACP timeout/);
    console.log(JSON.stringify({passed:true,continuousProgressSurvives:true,silenceTimesOut:true,unrelatedProgressIgnored:true}));
} finally { client.stop(); }
