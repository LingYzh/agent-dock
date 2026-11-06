import { initializeParams } from './identity.mjs';
import { configureSession } from './session-config.mjs';

export function sessionParams(agent) {
    return { cwd: agent.cwd, mcpServers: [], ...(agent.provider === 'claude' ? { _meta: { claudeCode: { options: { allowDangerouslySkipPermissions: false } } } } : {}) };
}

function savedConfiguration(options = []) {
    const requested = {};
    for (const [key, category, ids] of [['model', 'model', ['model']], ['thoughtLevel', 'thought_level', ['thought_level', 'effort']], ['permissionMode', 'mode', ['mode']]]) {
        const option = options.find((item) => item.category === category) || options.find((item) => ids.includes(item.id));
        if (option) requested[key] = option.currentValue;
    }
    return requested;
}

export async function restoreSession(agent, createClient, record) {
    const previousStatus = agent.recovery?.previousStatus || agent.status;
    const requested = agent.recovery?.phase !== 'ready' && agent.recovery?.requested || savedConfiguration(agent.configOptions);
    const originalSessionId = agent.sessionId;
    const empty = !agent.events.some((event) => event.method === 'bridge/prompt' || ['user_message_chunk', 'agent_message_chunk', 'tool_call'].includes(event.params?.update?.sessionUpdate));
    agent.status = 'starting';
    agent.recovery = { previousStatus, requested, phase: 'loading', at: new Date().toISOString() };
    record(agent, 'bridge/recovery_started', {});
    try {
        // session/load replays history. Keep our durable timeline as the source of
        // truth; replay must not duplicate messages, tool calls or token usage.
        agent.client = createClient(agent, true);
        agent.info = await agent.client.request('initialize', initializeParams());
        if (!agent.sessionId || !agent.info.agentCapabilities?.loadSession) throw new Error('Agent does not support loading this saved session');
        let loaded;
        let recreated = false;
        try {
            loaded = await agent.client.request('session/load', { ...sessionParams(agent), sessionId: agent.sessionId }, 60000);
        } catch (error) {
            let code;
            try { code = JSON.parse(error.message).code; } catch {}
            // Claude does not write a transcript for an unused session. Recreate
            // only an empty, missing session; never replace a conversation with history.
            if (agent.provider !== 'claude' || !empty || code !== -32002) throw error;
            loaded = await agent.client.request('session/new', sessionParams(agent), 60000);
            agent.sessionId = loaded.sessionId;
            recreated = true;
        }
        agent.configOptions = loaded.configOptions;
        // AGY load currently resets model/effort to provider defaults.
        // Do not allow a subsequent prompt until every saved value is confirmed.
        await configureSession(agent, requested);
        const interrupted = !['idle', 'completed', 'cancelled'].includes(previousStatus);
        agent.status = interrupted ? 'cancelled' : previousStatus;
        agent.error = undefined;
        agent.recovery = { previousStatus: agent.status, phase: 'ready', at: new Date().toISOString(), recreated, originalSessionId, interrupted };
        agent.client.replaying = false;
        record(agent, 'bridge/recovered', { configOptions: agent.configOptions, recreated, interrupted, originalSessionId, sessionId: agent.sessionId });
    } catch (error) {
        agent.status = 'error';
        agent.error = `会话恢复失败，历史已保留：${error.message}`;
        agent.recovery.phase = 'failed';
        agent.client?.stop();
        record(agent, 'bridge/error', { message: agent.error });
    }
}
