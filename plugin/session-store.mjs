import { mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, truncateSync } from 'node:fs';
import path from 'node:path';

export function applySessionEvent(agent, event) {
    const update = event.params?.update;
    if (event.params?.configOptions) agent.configOptions = event.params.configOptions;
    if (update?.sessionUpdate === 'config_option_update') agent.configOptions = update.configOptions;
    if (update?.sessionUpdate === 'available_commands_update') agent.availableCommands = update.availableCommands;
    if (update?.sessionUpdate === 'usage_update') agent.contextUsage = update;
    if (['bridge/closed', 'bridge/archive_cleanup'].includes(event.method) && event.params?.archive) agent.archive = event.params.archive;
    agent.events.push(event);
}

function serializable(agent) {
    const { client, pendingPermissions, ...saved } = agent;
    return saved;
}

// Each session has an atomic checkpoint followed by flushed event records. Streaming
// appends do not rewrite its complete transcript, and never persist live approval handles.
export class SessionStore {
    constructor(directory) {
        this.directory = directory;
        mkdirSync(directory, { recursive: true });
    }

    file(id) {
        if (!/^[a-f\d-]{36}$/i.test(id)) throw new Error('Invalid persisted session id');
        return path.join(this.directory, `${id}.jsonl`);
    }

    checkpoint(agent) {
        const file = this.file(agent.id);
        writeFileSync(`${file}.tmp`, JSON.stringify({ snapshot: serializable(agent) }) + '\n', { flush: true });
        renameSync(`${file}.tmp`, file);
    }

    append(agent, event) {
        const state = { status: agent.status, sessionId: agent.sessionId, error: agent.error ?? null, result: agent.result ?? null, recovery: agent.recovery ?? null };
        appendFileSync(this.file(agent.id), JSON.stringify({ event, state }) + '\n', { flush: true });
    }

    load() {
        return readdirSync(this.directory).filter((file) => file.endsWith('.jsonl')).map((file) => {
            const journal = path.join(this.directory, file);
            const bytes = readFileSync(journal);
            // A killed writer may leave an unterminated final record. Do not accept it,
            // nor silently skip corruption in an earlier committed record.
            const end = bytes.lastIndexOf(10) + 1;
            const lines = bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean);
            let agent;
            for (const line of lines) {
                const row = JSON.parse(line);
                if (row.snapshot) agent = row.snapshot;
                else {
                    if (!agent || row.event.seq !== agent.events.length + 1) throw new Error(`Invalid session journal: ${file}`);
                    applySessionEvent(agent, row.event);
                    Object.assign(agent, row.state);
                }
            }
            if (!agent || path.basename(this.file(agent.id)) !== file) throw new Error(`Invalid session checkpoint: ${file}`);
            delete agent.pendingPermissions;
            // Repair only an incomplete tail. Rewriting every full transcript
            // before the bridge starts listening penalizes large archives.
            if (end !== bytes.length) truncateSync(journal, end);
            return agent;
        });
    }
}
