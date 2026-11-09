import { AcpClient } from './acp.mjs';
import { closeProviderSession } from './session-archive.mjs';

// A provider uses one launch environment (including the user's login). Each
// acquired handle owns one provider session, never the entire shared transport.
export class AcpSessionPool {
    constructor(provider, cwd) {
        this.provider = provider;
        this.cwd = cwd;
    }

    start() {
        const host = { members: new Set(), bySession: new Map(), setup: Promise.resolve() };
        host.transport = new AcpClient(this.provider.command, this.cwd, function onEvent(method, params) {
            const member = host.bySession.get(params?.sessionId);
            if (member && !member.closing) member.handlers.onEvent(method, params);
            else if (!member && params?.sessionId && method === 'session/update' && host.creating?.length < 128) {
                // A provider can emit initial updates before returning the ID.
                host.creating.push({ method, params });
            }
        }, {
            ...this.provider,
            onPermission(kind, permission) {
                const member = host.bySession.get(permission.params.sessionId);
                if (member && !member.closing) member.handlers.onPermission(kind, permission);
                else if (kind === 'pending') host.transport.resolvePermission(permission.id, undefined, 'inactive_session');
            },
            onDisconnect: (error) => {
                if (this.host !== host) return;
                this.host = undefined;
                try { host.transport.stop(); }
                finally {
                    for (const member of host.members) {
                        if (!member.closing) member.handlers.onDisconnect(error);
                    }
                    host.members.clear();
                    host.bySession.clear();
                }
            }
        });
        this.host = host;
        return host;
    }

    acquire(handlers) {
        const host = this.host ?? this.start();
        const transport = host.transport;
        const member = { handlers };
        host.members.add(member);

        function bind(sessionId) {
            const existing = host.bySession.get(sessionId);
            if (!sessionId || (existing && existing !== member)) throw new Error('ACP provider returned an invalid or duplicate session ID');
            // Claude may recreate an empty session whose old transcript is missing.
            if (member.sessionId && member.sessionId !== sessionId) host.bySession.delete(member.sessionId);
            member.sessionId = sessionId;
            host.bySession.set(sessionId, member);
        }

        function checkOpen() {
            if (transport.failure || member.closing || transport.stopping) throw transport.failure || new Error('ACP session is closed');
        }

        function checkSession(params) {
            checkOpen();
            if (!member.sessionId || params?.sessionId !== member.sessionId) throw new Error('ACP session does not belong to this handle');
        }

        function open(params, timeout) {
            // Serializing creation bounds the early-update buffer to one new
            // session. Already bound sessions continue to stream in parallel.
            const pending = host.setup.then(async function createSession() {
                checkOpen();
                host.creating = [];
                try {
                    const result = await transport.request('session/new', params, timeout);
                    checkOpen();
                    bind(result.sessionId);
                    for (const event of host.creating) {
                        if (event.params.sessionId === member.sessionId) handlers.onEvent(event.method, event.params);
                    }
                    return result;
                } finally {
                    host.creating = undefined;
                }
            });
            host.setup = pending.catch(() => {});
            return pending;
        }

        const pool = this;
        return {
            shared: true,
            get failure() { return transport.failure; },
            async request(method, params, timeout) {
                checkOpen();
                if (method === 'initialize') return host.initialization ??= transport.request(method, params, timeout);
                if (method === 'session/new') return open(params, timeout);
                if (method === 'session/load') bind(params.sessionId);
                checkSession(params);
                return transport.request(method, params, timeout);
            },
            notify(method, params) {
                checkSession(params);
                transport.notify(method, params);
            },
            permissionSnapshots() {
                return member.sessionId ? transport.permissionSnapshots(member.sessionId) : [];
            },
            resolvePermission(id, optionId, reason) {
                if (!member.sessionId || transport.permissions.get(id)?.params.sessionId !== member.sessionId) throw new Error('Permission request does not belong to this session');
                return transport.resolvePermission(id, optionId, reason);
            },
            cancelPermissions(reason) {
                if (member.sessionId) transport.cancelPermissions(reason, true, member.sessionId);
            },
            stop({ cancelTurn = false } = {}) {
                if (member.cleanup) return member.cleanup;
                member.closing = true;
                member.cleanup = (async function disposeSession() {
                    const sessionId = member.sessionId;
                    let acp = { state: 'skipped' };
                    let process;
                    try {
                        if (sessionId && !transport.failure && !transport.stopping) {
                            if (cancelTurn) transport.notify('session/cancel', { sessionId });
                            else transport.cancelPermissions('session_closed', true, sessionId);
                            acp = await closeProviderSession(transport, sessionId, pool.provider.sessionCloseTimeoutMs ?? 1200);
                            if (cancelTurn && !['closed', 'already_closed'].includes(acp.state)) transport.fail(new Error('ACP provider did not confirm closing a timed-out turn'));
                        }
                    } catch (error) {
                        if (cancelTurn) transport.fail(new Error('Could not cancel the timed-out ACP turn', { cause: error }));
                        else throw error;
                    } finally {
                        if (sessionId) host.bySession.delete(sessionId);
                        host.members.delete(member);
                        if (!host.members.size && pool.host === host) process = pool.stop();
                    }
                    return { acp, process: process || transport.stopOutcome || (pool.host === host ? 'shared_kept' : 'unconfirmed') };
                })();
                return member.cleanup;
            }
        };
    }

    stop() {
        const host = this.host;
        this.host = undefined;
        return host?.transport.stop();
    }
}
