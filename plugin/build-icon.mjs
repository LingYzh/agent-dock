import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile } from 'node:fs/promises';

const svg = await readFile(new URL('assets/icon.svg', import.meta.url));
for (const [name, width] of [['icon.png', 128], ['logo.png', 512]]) {
    const rendered = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
    await writeFile(new URL(`assets/${name}`, import.meta.url), rendered.asPng());
}
console.log('Agent Dock SVG rendered to 128px icon and 512px logo.');
