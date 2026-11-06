import path from 'node:path';
import os from 'node:os';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';

export function defaultHome(env = process.env) {
    return path.join(env.LOCALAPPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Local'), 'AgentDock');
}

function readSettings(file) {
    try { return JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') return {};
        throw new Error(`Cannot read Agent Dock settings: ${file}. ${error.message}`);
    }
}

// This file contains paths only. Never persist or report provider credentials.
export function installationSettings(env = process.env, overrides = {}) {
    const standard = defaultHome(env);
    const locator = overrides.home || env.AGENT_DOCK_HOME ? {} : readSettings(path.join(standard, 'installation.json'));
    const home = path.resolve(overrides.home || env.AGENT_DOCK_HOME || locator.home || standard);
    const settings = readSettings(path.join(home, 'settings.json'));
    return {
        home,
        state: path.resolve(overrides.state || env.AGENT_DOCK_STATE_DIR || settings.state || path.join(home, 'state')),
        agyBin: overrides.agyBin || env.AGY_BIN || settings.agyBin,
        npmCache: path.join(home, 'npm-cache')
    };
}

function isFile(file) {
    try { return statSync(file).isFile(); } catch { return false; }
}

export function findExecutable(name, env = process.env) {
    for (const directory of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
        const file = path.join(directory.replace(/^"|"$/g, ''), name);
        if (isFile(file)) return file;
    }
    return undefined;
}

export function findAgy(settings, env = process.env) {
    if (settings.agyBin) {
        const executable = path.resolve(settings.agyBin);
        return isFile(executable) && /\.exe$/i.test(executable) ? executable : undefined;
    }
    return findExecutable('agy.exe', env) || [
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'),
        path.join(env.USERPROFILE || os.homedir(), '.agy', 'bin', 'agy.exe')
    ].filter(Boolean).find(isFile);
}

export function findNpm(env = process.env) {
    // Run npm's JS entrypoint with Node: avoid a cmd.exe quoting boundary for
    // user-chosen paths containing spaces or shell metacharacters.
    const directories = new Set([path.dirname(process.execPath), ...(env.PATH || env.Path || '').split(path.delimiter)]);
    for (const directory of directories) {
        if (!directory) continue;
        const candidate = path.join(directory.replace(/^"|"$/g, ''), 'node_modules', 'npm', 'bin', 'npm-cli.js');
        if (isFile(candidate)) return candidate;
    }
    const command = findExecutable('npm', env);
    if (command && existsSync(command)) {
        const target = realpathSync(command);
        if (target.endsWith('npm-cli.js')) return target;
    }
    return undefined;
}

export function environmentReport(settings, env = process.env) {
    const npm = findNpm(env);
    const agy = findAgy(settings, env);
    return {
        platform: process.platform,
        node: process.versions.node,
        supported: process.platform === 'win32' && Number(process.versions.node.split('.')[0]) >= 22,
        npmFound: Boolean(npm),
        codexCliFound: Boolean(findExecutable('codex.exe', env) || findExecutable('codex.cmd', env)),
        gitFound: Boolean(findExecutable('git.exe', env)),
        home: settings.home,
        state: settings.state,
        providers: {
            antigravity: { executableFound: Boolean(agy), executable: agy || null, login: 'Not probed; authenticate your own agy CLI before use.' },
            claude: { adapter: 'Installed with Agent Dock', login: 'Not probed; uses your own Claude Code login, standard settings or provider environment variables. CC Switch is optional.' }
        },
        errors: [
            ...(process.platform !== 'win32' ? ['This beta supports Windows only.'] : []),
            ...(Number(process.versions.node.split('.')[0]) < 22 ? ['Node.js 22 or newer is required.'] : []),
            ...(!npm ? ['npm was not found beside Node or on PATH. Install Node.js including npm.'] : []),
            ...(settings.agyBin && !agy ? ['The configured AGY_BIN must point to an existing agy.exe.'] : [])
        ],
        warnings: !agy ? ['Antigravity is unavailable. Install its CLI or set AGY_BIN; Claude Code can be used independently.'] : []
    };
}
