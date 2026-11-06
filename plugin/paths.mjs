import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installationSettings } from './environment.mjs';

export const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
// State is per user, outside plugin caches/versioned binaries, shared across chats.
export const stateRoot = installationSettings().state;
