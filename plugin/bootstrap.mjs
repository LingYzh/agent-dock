import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, open, unlink, rename, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { defaultHome, installationSettings, environmentReport, findNpm } from './environment.mjs';

const source = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function option(name) {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
    return args[index + 1];
}
async function atomicJson(file, value) {
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 4) + '\n');
    await rename(temp, file);
}
function runNode(script, argv, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...argv], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env });
        // Keep the MCP stdout channel clean; npm logs can contain registry details,
        // so report the actionable exit status rather than forwarding its output.
        child.stderr.resume();
        child.once('error', reject);
        child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`Dependency installation failed (npm exit ${code}). Check network/proxy access to registry.npmjs.org and run install.ps1 again.`)));
    });
}
async function prepare(settings) {
    const report = environmentReport(settings);
    if (report.errors.length) throw new Error(report.errors.join('\n'));
    const manifestText = await readFile(path.join(source, 'runtime-files.json'), 'utf8');
    const manifest = JSON.parse(manifestText);
    const fingerprint = createHash('sha256').update(manifestText).digest('hex').slice(0, 16);
    const runtime = path.join(settings.home, 'runtime', `${manifest.version}-${fingerprint}`);
    const readyFile = path.join(runtime, '.ready.json');
    async function ready() {
        try { return JSON.parse(await readFile(readyFile, 'utf8')).fingerprint === fingerprint; }
        catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    }
    if (await ready()) return runtime;
    await mkdir(path.dirname(runtime), { recursive: true });
    const lockFile = `${runtime}.lock`;
    let lock;
    const deadline = Date.now() + 150000;
    while (!lock) {
        try { lock = await open(lockFile, 'wx'); await lock.writeFile(String(process.pid)); }
        catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const owner = Number(await readFile(lockFile, 'utf8').catch(() => ''));
            if (owner) {
                try { process.kill(owner, 0); }
                catch (probeError) { if (probeError.code === 'ESRCH') await unlink(lockFile).catch(() => {}); }
            } else {
                // A process can exit between exclusive creation and writing its PID.
                const info = await stat(lockFile).catch(() => null);
                if (info && Date.now() - info.mtimeMs > 30000) await unlink(lockFile).catch(() => {});
            }
            if (await ready()) return runtime;
            if (Date.now() > deadline) throw new Error('Another Agent Dock installation is still running. Retry after it finishes.');
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    try {
        if (await ready()) return runtime;
        await mkdir(runtime, { recursive: true });
        for (const [relative, expected] of Object.entries(manifest.files)) {
            const input = path.resolve(source, relative);
            const output = path.resolve(runtime, relative);
            if (!input.startsWith(source + path.sep) || !output.startsWith(runtime + path.sep)) throw new Error('Invalid runtime file path');
            const bytes = await readFile(input);
            if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Package checksum mismatch: ${relative}`);
            await mkdir(path.dirname(output), { recursive: true });
            await copyFile(input, output);
        }
        // An empty user npm config and explicit public registry avoid depending on
        // the publisher's private registry settings. Existing proxy env still works.
        const npmConfig = path.join(runtime, '.npm-install-config');
        await writeFile(npmConfig, '');
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)));
        await runNode(findNpm(), ['ci', '--prefix', runtime, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--userconfig', npmConfig, '--cache', settings.npmCache], env);
        await atomicJson(readyFile, { fingerprint, version: manifest.version });
        return runtime;
    } finally {
        await lock.close();
        await unlink(lockFile).catch(() => {});
    }
}

try {
    const settings = installationSettings(process.env, { home: option('--home'), state: option('--state'), agyBin: option('--agy-bin') });
    if (args.includes('--doctor')) {
        const report = environmentReport(settings);
        console.log(JSON.stringify(report, null, 4));
        process.exitCode = report.errors.length ? 1 : 0;
    } else {
        const runtime = await prepare(settings);
        if (args.includes('--install')) {
            await atomicJson(path.join(settings.home, 'settings.json'), { state: settings.state, ...(settings.agyBin ? { agyBin: settings.agyBin } : {}) });
            // A tiny user-local pointer makes custom drives discoverable to plugins
            // launched by the desktop, without requiring system environment edits.
            await atomicJson(path.join(defaultHome(), 'installation.json'), { home: settings.home });
        }
        if (args.includes('--prepare') || args.includes('--install')) console.log(JSON.stringify({ prepared: true, runtime, home: settings.home, state: settings.state }));
        else {
            process.env.AGENT_DOCK_HOME = settings.home;
            process.env.AGENT_DOCK_STATE_DIR = settings.state;
            if (settings.agyBin) process.env.AGY_BIN = settings.agyBin;
            await import(pathToFileURL(path.join(runtime, 'mcp.mjs')).href);
        }
    }
} catch (error) {
    console.error(`Agent Dock: ${error.message}`);
    process.exitCode = 1;
}
