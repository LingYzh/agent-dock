import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({ entryPoints: [path.join(root, 'panel.mjs')], bundle: true, write: false, format: 'esm', platform: 'browser', minify: true });
const template = await readFile(path.join(root, 'panel-template.html'), 'utf8');
const css = await readFile(path.join(root, 'panel.css'), 'utf8');
const icon = await readFile(path.join(root, 'assets/icon.svg'));
const html = template.replace('__AGENT_DOCK_ICON__', `data:image/svg+xml;base64,${icon.toString('base64')}`).replace('/* PANEL_CSS */', css).replace('/* PANEL_JS */', () => bundle.outputFiles[0].text.replaceAll('</script', '<\\/script'));
await writeFile(path.join(root, 'panel.html'), html);
console.log(`Built panel.html (${Buffer.byteLength(html)} bytes)`);
