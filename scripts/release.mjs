import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'plugin/package.json'), 'utf8'));
export const runtimeFiles = [
    'package.json', 'package-lock.json', 'acp.mjs', 'acp-pool.mjs', 'ensure-service.mjs', 'identity.mjs',
    'mcp.mjs', 'paths.mjs', 'environment.mjs', 'providers.mjs', 'service.mjs',
    'session-config.mjs', 'session-store.mjs', 'session-recovery.mjs', 'session-archive.mjs',
    'panel.html', 'panel.mjs', 'panel-view.mjs', 'panel-sync.mjs', 'panel-state.mjs', 'panel-detail.mjs', 'timeline-window.mjs', 'worktree.mjs',
    'session-setup.mjs', 'usage.mjs', 'markdown.mjs', 'link-target.mjs',
    'assets/icon.svg', 'assets/icon.png', 'assets/logo.png'
];
const files = {};
for (const file of runtimeFiles) files[file] = createHash('sha256').update(await readFile(path.join(root, 'plugin', file))).digest('hex');
await writeFile(path.join(root, 'plugin/runtime-files.json'), JSON.stringify({ version, files }, null, 4) + '\n');
const manifestPath = path.join(root, 'plugin/.codex-plugin/plugin.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.version = version;
await writeFile(manifestPath, JSON.stringify(manifest, null, 4) + '\n');
console.log(`Prepared ${version}: ${runtimeFiles.length} checksum-verified runtime files.`);
