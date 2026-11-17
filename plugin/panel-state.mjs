// Duplicate deltas cannot duplicate tokens or transcript rows. Selection refreshes
// request the latest window even when an immediately displayed cache exists.
export function panelSyncArgs(state, selected, revision, loadLegacyHistory = false, latest = false) {
    const current = state && state.id === selected;
    // A bridge left running across an upgrade may still return oldest-first pages.
    if (!latest && current && state.hasMore && state.startCursor === undefined && !loadLegacyHistory) return { revision };
    return { id: selected, after: current && !latest ? state.cursor : undefined, status: current && !latest ? state.status : undefined, revision, recent: true, compact: true };
}

// Retain only a few compact recent windows, never complete loaded histories or
// approval payloads. This keeps switching responsive without growing per session.
export function createPanelCache() {
    const entries = new Map();
    const encoder = new TextEncoder();
    const maxBytes = 256 * 1024;
    return {
        remember(state) {
            if (!state || state.hasMore || !Number.isInteger(state.cursor)) return;
            entries.delete(state.id);
            const events = state.events.slice(-200);
            const cached = { ...state, events: [], pendingPermissions: [], replace: false, hasMore: false };
            // Leave room for the new start cursor and array punctuation.
            let bytes = encoder.encode(JSON.stringify(cached)).length + 64;
            let start = events.length;
            for (let index = events.length - 1; index >= 0; index--) {
                const size = encoder.encode(JSON.stringify(events[index])).length + 1;
                if (bytes + size > maxBytes) break;
                bytes += size;
                start = index;
            }
            if (bytes > maxBytes || (events.length && start === events.length)) return;
            cached.events = events.slice(start);
            cached.startCursor = cached.events.length ? cached.events[0].seq - 1 : state.cursor;
            entries.set(state.id, cached);
            while (entries.size > 4) entries.delete(entries.keys().next().value);
        },
        get(id) {
            const cached = entries.get(id);
            if (!cached) return;
            entries.delete(id);
            entries.set(id, cached);
            return cached;
        }
    };
}

export function mergePanelState(previous, incoming) {
    if (!incoming) return previous;
    if (!previous || previous.id !== incoming.id || incoming.replace) return incoming;
    if (incoming.cursor < previous.cursor) return previous;
    const added = incoming.events.filter((event) => event.seq > previous.cursor);
    return { ...incoming, startCursor: previous.startCursor, events: added.length ? [...previous.events, ...added] : previous.events };
}

export function prependPanelHistory(state, page) {
    if (!state || page?.id !== state.id || page.cursor !== state.startCursor || !Number.isInteger(page.startCursor) || page.startCursor >= page.cursor) return state;
    return { ...state, startCursor: page.startCursor, events: [...page.events, ...state.events] };
}

export function pollDelay({ hidden, catchingUp, active, failures = 0 }) {
    if (hidden) return null;
    if (failures) return Math.min(60000, 2000 * 2 ** Math.min(failures, 5));
    return catchingUp ? 200 : active ? 2000 : 15000;
}
