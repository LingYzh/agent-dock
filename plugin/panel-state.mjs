// Only the selected session is retained. Duplicate deltas cannot duplicate tokens
// or transcript rows, and switching sessions discards the old in-memory history.
export function panelSyncArgs(state, selected, revision) {
    const current = state && state.id === selected;
    return { id: selected, after: current ? state.cursor : undefined, status: current ? state.status : undefined, revision };
}

export function mergePanelState(previous, incoming) {
    if (!incoming) return previous;
    if (!previous || previous.id !== incoming.id || incoming.replace) return incoming;
    if (incoming.cursor < previous.cursor) return previous;
    const added = incoming.events.filter((event) => event.seq > previous.cursor);
    return { ...incoming, events: added.length ? [...previous.events, ...added] : previous.events };
}

export function pollDelay({ hidden, hasMore, active, failures = 0 }) {
    if (hidden) return null;
    if (failures) return Math.min(60000, 2000 * 2 ** Math.min(failures, 5));
    return hasMore ? 200 : active ? 2000 : 15000;
}
