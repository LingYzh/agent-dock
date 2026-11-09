export async function closeProviderSession(client, sessionId, timeout) {
    if (!sessionId) return { state: 'skipped' };
    const started = performance.now();
    let state = 'closed';
    let code;
    try { await client.request('session/close', { sessionId }, timeout); }
    catch (error) {
        let rpc;
        try { rpc = JSON.parse(error.message); } catch {}
        code = Number.isInteger(rpc?.code) ? rpc.code : undefined;
        state = code === -32601 ? 'unsupported'
            : /^ACP timeout:/.test(error.message) ? 'timeout'
            : /session.*(?:closed|not found|not loaded)/i.test(rpc?.message || error.message) ? 'already_closed'
            : 'failed';
    }
    return { state, code, ms: Math.round(performance.now() - started) };
}

export async function archiveSession(agent, record) {
    if (agent.status === 'closed') return;
    if (['starting', 'configuring', 'running', 'blocked', 'cancelling'].includes(agent.status)) throw new Error('Cancel the active turn before closing');
    const { client, sessionId, status } = agent;
    // Archiving is a local operation. Commit the close event before asking the
    // provider to clean up, so slow or unsupported close RPCs cannot veto it.
    const started = performance.now();
    try { record(agent, 'bridge/closed', { archive: { storage: 'saved', cleanup: 'pending' } }, { status: 'closed', recovery: undefined }); }
    catch (error) { throw new Error(`归档保存失败：${error.code || error.message}`, { cause: error }); }
    const storageMs = Math.round(performance.now() - started);
    const cleanupStarted = performance.now();
    let acp = { state: 'skipped' };
    let process = 'not_started';
    try {
        if (client?.shared) ({ acp, process } = await client.stop());
        else if (client) {
            if (status !== 'error') acp = await closeProviderSession(client, sessionId, 1200);
            process = await client.stop() || 'unconfirmed';
        }
    } catch (error) {
        process = 'failed';
        console.warn('Could not clean up archived ACP process:', error.message);
    } finally {
        delete agent.client;
    }
    const archive = { storage: 'saved', storageMs, cleanup: 'finished', acp, process, cleanupMs: Math.round(performance.now() - cleanupStarted) };
    try { record(agent, 'bridge/archive_cleanup', { archive }); }
    catch (error) {
        // The local close was already durable. Do not report it as failed just
        // because the optional diagnostics write failed afterwards.
        agent.archive = { ...archive, diagnosticsSaved: false };
        console.warn('Could not save archive diagnostics:', error.message);
    }
}
