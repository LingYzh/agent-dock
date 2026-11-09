export const states = { starting: '正在启动', configuring: '正在配置', idle: '待命', running: '运行中', blocked: '等待权限审批', cancelling: '正在取消', completed: '已完成', cancelled: '已取消', closed: '已关闭', error: '异常' };

export function projectEvents(events, state) {
    const items = [];
    const tools = new Map();
    let assistant;
    let thought;
    let turnStartLoaded = !state?.startCursor;
    let turnHasThought = false;
    for (const event of events || []) {
        const update = event.params?.update;
        if (event.method === 'bridge/prompt') {
            if (thought) thought.streaming = false;
            assistant = undefined;
            thought = undefined;
            turnStartLoaded = true;
            turnHasThought = false;
            items.push({ type: 'user', id: `user-${event.seq ?? items.length}`, text: event.params.text, at: event.at });
        } else if (update?.sessionUpdate === 'agent_thought_chunk') {
            assistant = undefined;
            if (!thought) {
                thought = { type: 'thought', id: `thought-${event.seq ?? items.length}`, text: '', streaming: true, at: event.at };
                items.push(thought);
            }
            thought.text += update.content?.text || '';
            turnHasThought = true;
        } else if (update?.sessionUpdate === 'agent_message_chunk') {
            if (thought) thought.streaming = false;
            thought = undefined;
            if (!assistant) {
                assistant = { type: 'assistant', id: `assistant-${event.seq ?? items.length}`, text: '', at: event.at };
                items.push(assistant);
            }
            assistant.text += update.content?.text || '';
        } else if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) {
            assistant = undefined;
            if (thought) thought.streaming = false;
            thought = undefined;
            let item = tools.get(update.toolCallId);
            if (!item) {
                item = { type: 'tool', id: update.toolCallId, at: event.at };
                tools.set(update.toolCallId, item);
                items.push(item);
            }
            Object.assign(item, update);
        } else if (event.method === 'session/request_permission') {
            items.push({ type: 'notice', id: `notice-${event.seq ?? items.length}`, text: '代理请求操作权限。审批结果会记录在此处。', at: event.at });
        } else if (event.method === 'bridge/permission_resolved') {
            const kind = event.params.optionKind;
            items.push({ type: 'notice', id: `notice-${event.seq ?? items.length}`, text: event.params.outcome?.outcome === 'cancelled' ? '权限请求已取消。' : kind?.startsWith('allow') ? '已允许此操作。' : kind?.startsWith('reject') ? '已拒绝此操作。' : '已提交权限决定。', at: event.at });
        } else if (event.method === 'bridge/recovered') {
            assistant = undefined;
            if (thought) thought.streaming = false;
            thought = undefined;
            // Routine reconnects are transient UI messages, not conversation turns.
            // Keep recovery exceptions visible because they affect task continuity.
            if (event.params.recreated || event.params.interrupted) items.push({ type: 'notice', id: `notice-${event.seq ?? items.length}`, text: event.params.recreated ? '空会话未被 Agent 保存，已按原配置重新建立；未发送任务。' : '会话已恢复；重启前未结束的任务和审批已中断，不会自动重发。', at: event.at });
        } else if (event.method === 'bridge/error') {
            if (thought) thought.streaming = false;
            thought = undefined;
            assistant = undefined;
            items.push({ type: 'error', id: `error-${event.seq ?? items.length}`, text: event.params.message, at: event.at });
        } else if (event.method === 'bridge/turn_end') {
            assistant = undefined;
            if (thought) thought.streaming = false;
            thought = undefined;
            // Token accounting is not a thought transcript: report absence rather than fabricate it.
            if (turnStartLoaded && !turnHasThought && event.params.usage?.thoughtTokens > 0) {
                items.push({ type: 'thought', id: `thought-unavailable-${event.seq}`, text: '', unavailable: true, tokens: event.params.usage.thoughtTokens, at: event.at });
            }
            items.push({ type: 'end', id: `end-${event.seq ?? items.length}`, text: event.params.stopReason === 'cancelled' ? '任务已取消' : '本轮执行结束', usage: event.params.usage, at: event.at });
        }
    }
    // A page boundary can cut through an old thought before its terminal event.
    // Only a fully caught-up, active session can have a live thought disclosure.
    if (state && (state.hasMore || !['running', 'blocked'].includes(state.status))) {
        for (const item of items) if (item.type === 'thought') item.streaming = false;
    }
    return items;
}

export function recoveryMessage(events, after) {
    if (!Number.isInteger(after)) return undefined;
    return events?.findLast((event) => event.seq > after && event.method === 'bridge/recovered' && !event.params?.interrupted && !event.params?.recreated)
        ? '会话已恢复，模型和思考设置已确认。' : undefined;
}

// Group only adjacent tool entries. Messages, thoughts and permission notices keep
// their original chronology; updates already resolve into the same tool entry above.
export function groupConsecutiveTools(items) {
    const result = [];
    for (let index = 0; index < items.length;) {
        const item = items[index];
        if (item.type !== 'tool') {
            result.push(item);
            index++;
            continue;
        }
        const children = [];
        while (items[index]?.type === 'tool') children.push(items[index++]);
        result.push(children.length === 1 ? item : { type: 'tool-group', id: `tool-group:${item.id}`, children });
    }
    return result;
}

export function thoughtOpenState(streaming, previous) {
    // Collapse exactly at the streaming -> settled transition. Subsequent polling
    // preserves a user's manual reopen (or manual close while still streaming).
    if (previous?.streaming && !streaming) return false;
    return previous ? previous.open : Boolean(streaming);
}

export function toolOutput(item) {
    if (item.rawOutput?.output) return item.rawOutput.output;
    return (item.content || []).map((content) => {
        if (content.type === 'diff') return `${content.path}\n修改前：\n${content.oldText ?? '（新建文件）'}\n修改后：\n${content.newText ?? ''}`;
        return content.content?.text || content.text || '';
    }).filter(Boolean).join('\n');
}

export function toolPreview(item) {
    if (item.panelRawOutput?.text) return item.panelRawOutput;
    return item.panelContent ?? { text: toolOutput(item) };
}

export { usageSummary } from './usage.mjs';
