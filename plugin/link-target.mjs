// Keep navigation explicit: no executable schemes, protocol-relative hosts or UNC
// shares. Local source links go through the same host policy as web links.
export function linkTarget(href) {
    const value = String(href || '').trim();
    if (/^(?:https?:\/\/|mailto:)/i.test(value)) return value;
    let local = value;
    if (/^[a-z]:[\\/]/i.test(value)) local = `file:///${value.replaceAll('\\', '/')}`;
    else if (/^\/(?!\/)/.test(value)) local = `file://${value}`;
    if (/^file:\/\/\//i.test(local)) {
        try {
            const url = new URL(local);
            if (!url.hostname && !/^\/[\\/]/.test(decodeURIComponent(url.pathname))) return url.href;
        } catch { /* Invalid model-authored links stay plain text. */ }
    }
    return null;
}
