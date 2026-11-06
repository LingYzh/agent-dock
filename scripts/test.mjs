import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const plugin = fileURLToPath(new URL('../plugin/', import.meta.url));
mkdirSync(new URL('../plugin/work/evidence/', import.meta.url), { recursive: true });
for (const file of ['../tests/portable.mjs', 'verify-timeline-collapse.mjs', 'verify-links.mjs', 'verify-prompt-timeout.mjs', 'verify-permissions.mjs', 'verify-recovery.mjs']) {
    const result = spawnSync(process.execPath, [file], { cwd: plugin, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) process.exit(result.status || 1);
}
