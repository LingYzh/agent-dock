import { toolOutput } from './panel-view.mjs';

const previewChars = 2048;
const pageChars = 24 * 1024;
const projections = new WeakMap();

function toolUpdate(event) {
    const update = event.params?.update;
    return event.method === 'session/update' && ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) ? update : null;
}

// Do not split a surrogate pair at a preview/page boundary.
function safeEnd(text, index) {
    if (index > 0 && index < text.length && /[\uD800-\uDBFF]/.test(text[index - 1])) return index - 1;
    return index;
}

function outputText(update, source) {
    if (source === 'rawOutput') {
        const value = update.rawOutput?.output;
        return typeof value === 'string' ? value : value ? JSON.stringify(value, null, 4) : '';
    }
    return toolOutput({ content: update.content });
}

function preview(text, seq, source) {
    if (text.length <= previewChars) return { text };
    const head = safeEnd(text, previewChars * 3 / 4);
    const tail = safeEnd(text, text.length - previewChars / 4);
    return { text: `${text.slice(0, head)}\n…\n${text.slice(tail)}`, ref: { seq, source, length: text.length } };
}

export function compactPanelEvent(event) {
    const update = toolUpdate(event);
    if (!update) return event;
    const cached = projections.get(event);
    if (cached) return cached;
    // Only fields rendered by the timeline travel in normal sync. The original
    // event (including input, metadata and structured results) stays intact.
    const projected = { sessionUpdate: update.sessionUpdate, toolCallId: update.toolCallId };
    for (const field of ['title', 'name', 'kind', 'status']) {
        if (typeof update[field] === 'string') projected[field] = update[field].slice(0, safeEnd(update[field], 512));
    }
    for (const [source, field] of [['rawOutput', 'panelRawOutput'], ['content', 'panelContent']]) {
        if (Object.hasOwn(update, source)) projected[field] = preview(outputText(update, source), event.seq, source);
    }
    const result = { seq: event.seq, at: event.at, method: event.method, params: { sessionId: event.params.sessionId, update: projected } };
    projections.set(event, result);
    return result;
}

export function panelDetail(agent, { seq, source, offset = 0 }) {
    if (!Number.isInteger(seq) || seq < 1 || !Number.isInteger(offset) || offset < 0) throw new Error('Invalid panel detail cursor');
    const event = agent.events[seq - 1];
    if (!event || event.seq !== seq) throw new Error('Unknown session event');
    let text;
    if (source === 'event') text = JSON.stringify(event, null, 4);
    else if (['rawOutput', 'content'].includes(source) && toolUpdate(event)) text = outputText(event.params.update, source);
    else throw new Error('Unknown panel detail source');
    if (offset > text.length || safeEnd(text, offset) !== offset) throw new Error('Invalid detail offset');
    const end = safeEnd(text, Math.min(offset + pageChars, text.length));
    return { text: text.slice(offset, end), offset, next: end < text.length ? end : null, length: text.length };
}
