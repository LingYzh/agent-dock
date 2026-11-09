import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAgy, installationSettings } from './environment.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
// Keep launch commands server-owned; model callers cannot inject arbitrary executables.
export const providers = {
    agy: {
        name: 'Antigravity',
        command: findAgy(installationSettings()),
        args: ['acp'],
        defaultModel: 'gemini-3.8-flash'
    },
    claude: {
        name: 'Claude Code',
        command: process.execPath,
        args: [path.join(root, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')],
        // The adapter can wait up to five seconds for its cancelled turns to settle.
        sessionCloseTimeoutMs: 6000
    }
};

export function providerList() {
    return Object.entries(providers).map(([id, provider]) => ({ id, name: provider.name, defaultModel: provider.defaultModel }));
}
