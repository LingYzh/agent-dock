// Only the selected session is retained. Duplicate deltas cannot duplicate tokens
// or transcript rows, and switching sessions discards the old in-memory history.
export function panelSyncArgs(state, selected, revision, loadLegacyHistory = false) {
    const current = state && state.id === selected;
    // A bridge left running across an upgrade may still return oldest-first pages.
    if (current && state.hasMore && state.startCursor === undefined && !loadLegacyHistory) return { revision };
    return { id: selected, after: current ? state.cursor : undefined, status: current ? state.status : undefined, revision, recent: true, compact: true };
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
