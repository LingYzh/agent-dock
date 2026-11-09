import { readFile, open, unlink, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stateRoot } from './paths.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(stateRoot, '.local.json');
const lockFile = path.join(stateRoot, 'work/service-start.lock');

async function runningService() {
    try {
        const local = JSON.parse(await readFile(stateFile, 'utf8'));
        let response = await fetch(local.url + '/health', {
            headers: { Authorization: `Bearer ${local.token}` }, signal: AbortSignal.timeout(1500)
        });
        // Older live bridges have no health route. Preserve them during upgrades
        // rather than mistakenly spawning a second service against the same state.
        if (response.status === 404) {
            await response.body?.cancel();
            response = await fetch(local.url + '/tool', {
                method: 'POST', headers: { Authorization: `Bearer ${local.token}` },
                body: JSON.stringify({ name: 'agent_list' }), signal: AbortSignal.timeout(1500)
            });
        }
        // A health probe only needs the status; release the response stream instead
        // of leaving a complete registry response unread on every MCP request.
        await response.body?.cancel();
        return response.ok ? local : null;
    } catch { return null; }
}

export async function ensureService() {
    const running = await runningService();
    if (running) return running;
    await mkdir(path.join(stateRoot, 'work'), { recursive: true });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        let lock;
        try {
            lock = await open(lockFile, 'wx');
            await lock.writeFile(String(process.pid));
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
            // Only reclaim a dead starter's lock; another MCP instance may be launching now.
            const owner = Number(await readFile(lockFile, 'utf8').catch(() => ''));
            if (owner) {
                try { process.kill(owner, 0); }
                catch (processError) { if (processError.code === 'ESRCH') await unlink(lockFile).catch(() => {}); }
            } else {
                const info = await stat(lockFile).catch(() => null);
                if (info && Date.now() - info.mtimeMs > 15000) await unlink(lockFile).catch(() => {});
            }
            const ready = await runningService();
            if (ready) return ready;
            await new Promise((resolve) => setTimeout(resolve, 200));
            continue;
        }
        try {
            const ready = await runningService();
            if (ready) return ready;
            // The bridge is shared across MCP hosts. Its authenticated leases,
            // rather than the first host's process lifetime, control shutdown.
            const child = spawn(process.execPath, [path.join(root, 'service.mjs'), '--mcp-managed'], { cwd: root, windowsHide: true, detached: true, stdio: 'ignore' });
            let startError;
            child.once('error', function failed(error) { startError = error; });
            child.unref();
            while (Date.now() < deadline) {
                if (startError) throw startError;
                const local = await runningService();
                if (local) return local;
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            throw new Error('ACP bridge service did not become ready within 20 seconds');
        } finally {
            await lock.close();
            await unlink(lockFile).catch(() => {});
        }
    }
    throw new Error('Another MCP instance could not start the ACP bridge service');
}
