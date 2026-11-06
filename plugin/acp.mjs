import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { agentEnvironment } from './identity.mjs';
import { randomUUID } from 'node:crypto';

// Minimal ACP v1 client for the probe. Only advertise callbacks we implement.
export class AcpClient {
    constructor(executable, cwd, onEvent, options = {}) {
        this.pending = new Map();
        this.nextId = 0;
        this.onEvent = onEvent;
        this.permissions = new Map();
        this.onPermission = options.onPermission;
        this.process = spawn(executable, options.args || ['acp'], { cwd, env: { ...agentEnvironment(), ...options.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        this.process.stderr.on('data', function ignoreDiagnosticOutput() {});
        this.process.stdin.on('error', (error) => this.fail(error));
        createInterface({ input: this.process.stdout }).on('line', (line) => this.receive(line));
        this.process.on('error', (error) => this.fail(error));
        this.process.on('exit', (code) => this.fail(new Error(`ACP process exited (${code})`)));
    }

    receive(line) {
        let message;
        try { message = JSON.parse(line); } catch { return; }
        if (message.method) {
            if (message.method === 'session/update') this.refreshPromptTimers(message.params?.sessionId);
            this.onEvent(message.method, message.params);
            if (message.method === '$/cancel_request') {
                for (const permission of this.permissions?.values() || []) {
                    if (permission.rpcId === message.params?.requestId) this.resolvePermission(permission.id, undefined, 'agent_cancelled');
                }
                return;
            }
            if (message.id !== undefined) {
                if (message.method === 'session/request_permission' && this.onPermission) {
                    const permission = { id: randomUUID(), rpcId: message.id, params: message.params, createdAt: new Date().toISOString() };
                    this.permissions.set(permission.id, permission);
                    this.pausePromptTimers();
                    this.onPermission('pending', permission);
                    return;
                }
                // A client without an approval consumer must fail closed.
                const response = message.method === 'session/request_permission'
                    ? { result: { outcome: { outcome: 'cancelled' } } }
                    : { error: { code: -32601, message: 'Client capability not supported by probe' } };
                this.write({ jsonrpc: '2.0', id: message.id, ...response });
            }
            return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(JSON.stringify(message.error)));
        else request.resolve(message.result);
    }

    write(message) {
        this.process.stdin.write(JSON.stringify(message) + '\n');
    }

    request(method, params, timeout = 30000) {
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const request = { id, method, sessionId: params?.sessionId, timeout, resolve, reject, remaining: timeout };
            this.pending.set(id, request);
            this.armTimer(request);
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method, params) {
        this.write({ jsonrpc: '2.0', method, params });
        if (method === 'session/cancel') this.cancelPermissions('turn_cancelled');
    }

    armTimer(request) {
        clearTimeout(request.timer);
        request.startedAt = Date.now();
        request.timer = setTimeout(() => {
            this.pending.delete(request.id);
            request.reject(new Error(`ACP timeout: ${request.method}`));
        }, request.remaining);
    }

    refreshPromptTimers(sessionId) {
        if (!sessionId || this.permissions.size) return;
        for (const request of this.pending.values()) {
            if (request.method !== 'session/prompt' || request.sessionId !== sessionId || !request.timer) continue;
            // A coding turn can legitimately take much longer than one short reply.
            // Only matching-session progress resets the inactivity deadline.
            request.remaining = request.timeout;
            this.armTimer(request);
        }
    }

    pausePromptTimers() {
        for (const request of this.pending.values()) {
            if (request.method !== 'session/prompt' || !request.timer) continue;
            clearTimeout(request.timer);
            request.remaining = Math.max(1, request.remaining - (Date.now() - request.startedAt));
            request.timer = null;
        }
    }

    permissionSnapshots() {
        return [...this.permissions.values()].map(({ id, params, createdAt }) => ({ ...params, id, createdAt }));
    }

    resolvePermission(id, optionId, reason = 'decision', send = true) {
        const permission = this.permissions.get(id);
        if (!permission) throw new Error('Permission request is no longer pending');
        const option = optionId === undefined ? undefined : permission.params.options?.find((item) => item.optionId === optionId);
        if (optionId !== undefined && !option) throw new Error('Option was not offered by this permission request');
        const outcome = option ? { outcome: 'selected', optionId } : { outcome: 'cancelled' };
        if (send) this.write({ jsonrpc: '2.0', id: permission.rpcId, result: { outcome } });
        this.permissions.delete(id);
        this.onPermission?.('resolved', { ...permission, outcome, reason, optionKind: option?.kind });
        if (!this.permissions.size) {
            for (const request of this.pending.values()) if (request.method === 'session/prompt' && !request.timer) this.armTimer(request);
        }
        return outcome;
    }

    cancelPermissions(reason, send = true) {
        for (const id of this.permissions.keys()) this.resolvePermission(id, undefined, reason, send);
    }

    fail(error) {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }
        this.pending.clear();
        this.cancelPermissions('transport_closed', false);
    }

    stop() {
        this.cancelPermissions('session_closed');
        this.process.kill();
    }
}
