import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const plugin = path.dirname(fileURLToPath(import.meta.url));
const qa = path.resolve(plugin, '../.qa');
await mkdir(qa, { recursive: true });
const root = await mkdtemp(path.join(qa, 'clean-install-'));
const user = path.join(root, 'empty user');
const local = path.join(user, 'Local');
const home = path.join(root, 'home & 空格');
await mkdir(local, { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'OS', 'TEMP', 'TMP', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].includes(key.toUpperCase())));
Object.assign(env, { PATH: path.dirname(process.execPath), USERPROFILE: user, HOME: user, LOCALAPPDATA: local, APPDATA: path.join(user, 'Roaming'), AGENT_DOCK_HOME: home });
function node(argv) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, argv, { cwd: plugin, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)));
    });
}
const doctor = JSON.parse(await node(['bootstrap.mjs', '--doctor']));
assert.equal(doctor.providers.antigravity.executableFound, false);
assert.equal(doctor.errors.length, 0);
const prepared = JSON.parse(await node(['bootstrap.mjs', '--prepare']));
assert.ok(prepared.runtime.startsWith(home));
// Preparation must not write a user locator unless --install was explicitly used.
await assert.rejects(readFile(path.join(local, 'AgentDock/installation.json')), { code: 'ENOENT' });
const installed = JSON.parse(await node(['bootstrap.mjs', '--install']));
assert.equal(JSON.parse(await readFile(path.join(local, 'AgentDock/installation.json'), 'utf8')).home, home);
const firstMarker = await readFile(path.join(installed.runtime, '.ready.json'), 'utf8');
assert.equal(JSON.parse(await node(['bootstrap.mjs', '--prepare'])).runtime, prepared.runtime);
assert.equal(await readFile(path.join(installed.runtime, '.ready.json'), 'utf8'), firstMarker);
const client = new Client({ name: 'clean-profile-check', version: '1' });
let service;
try {
    // Exercise the exact public launcher; no publisher state, AGY, CCS or login.
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(plugin, 'bootstrap.mjs')], cwd: plugin, env }));
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 11);
    const list = await client.callTool({ name: 'agent_list', arguments: {} });
    assert.ok(!list.isError);
    assert.deepEqual(list.structuredContent.agents, []);
    service = JSON.parse(await readFile(path.join(home, 'state/.local.json'), 'utf8'));
    assert.equal((await fetch(service.url + '/health')).status, 401);
    const missing = await client.callTool({ name: 'agent_spawn', arguments: { provider: 'agy', name: 'missing provider test' } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /CLI was not found/);
    const html = await client.readResource({ uri: 'ui://agy-acp-probe/panel-v2.html' });
    assert.match(html.contents[0].text, /status-message/);
    const result = { passed: true, emptyProfile: true, missingAgyActionable: true, noLoginOrCCSRequiredForPanel: true, customPathWithSpacesAndUnicode: true, installIdempotent: true, liveSessions: 0, promptsSent: 0 };
    await writeFile(path.join(qa, 'clean-install-result.json'), JSON.stringify(result, null, 4));
    console.log(JSON.stringify(result));
} finally {
    await client.close();
    if (service) process.kill(service.pid);
}
