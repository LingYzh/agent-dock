// Independent, truthful identity. Never use an IDE's name to impersonate that client.
export const BRIDGE_IDENTITY = Object.freeze({ name: 'local-acp-bridge', title: 'Local ACP Bridge', version: '0.2.0' });

export function initializeParams() {
    return { protocolVersion: 1, clientCapabilities: {}, clientInfo: { ...BRIDGE_IDENTITY } };
}

export function agentEnvironment(source = process.env) {
    // Only keep OS execution, account lookup, proxy and documented provider configuration.
    const allowed = new Set([
        'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC',
        'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA',
        'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA',
        'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
        'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS',
        'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'CLOUDSDK_CONFIG',
        'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'
    ]);
    return Object.fromEntries(Object.entries(source).filter(([name]) => allowed.has(name.toUpperCase())));
}
