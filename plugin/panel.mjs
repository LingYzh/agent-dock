import { App } from '@modelcontextprotocol/ext-apps';
import { projectEvents, groupConsecutiveTools, thoughtOpenState, toolOutput, states, usageSummary, recoveryMessage } from './panel-view.mjs';
import { renderMarkdown } from './markdown.mjs';
import { linkTarget } from './link-target.mjs';
import { tokenComposition, cacheHitRate } from './usage.mjs';
import { panelSyncArgs, mergePanelState, pollDelay } from './panel-state.mjs';
import { createIcons, ArrowUp, Check, ChevronDown, Plus, RefreshCw, Pencil, Terminal, FileSearch, CircleCheck, X } from 'lucide';
import { createSessionSetup } from './session-setup.mjs';

// Import only used control icons; the header uses the original Agent Dock brand asset.
createIcons({ icons: { ArrowUp, Check, ChevronDown, Plus, RefreshCw, CircleCheck, X }, attrs: { class: 'ui-icon', width: 16, height: 16, 'stroke-width': 1.75, 'aria-hidden': 'true', focusable: 'false' } });

const embedded = window.parent !== window;
const app = embedded ? new App({ name: 'agent-dock-panel', version: '1.0.0' }, {}) : null;
const token = location.hash.slice(1) || sessionStorage.getItem('probe-token');
if (token && !embedded) {
    sessionStorage.setItem('probe-token', token);
    history.replaceState(null, '', location.pathname);
}
let selected;
let agents = [];
let state;
let filter = 'current';
let generation = 0;
let refreshing = false;
let pendingRefresh = false;
let actionPending = false;
let rendered = '';
let previewing = false;
let currentView = 'conversation';
let listRevision;
let pollTimer;
let failures = 0;
let pageActive = true;
const viewKeys = {};
let usageState;
let messageTimer;
let recoveryNoticeAfter;

function dismissMessage() {
    clearTimeout(messageTimer);
    document.querySelector('#status-message').hidden = true;
    document.querySelector('#status-message-text').textContent = '';
}
function showMessage(text) {
    dismissMessage();
    document.querySelector('#status-message').hidden = false;
    document.querySelector('#status-message-text').textContent = text;
    messageTimer = setTimeout(dismissMessage, 4000);
}
document.querySelector('#dismiss-message').onclick = dismissMessage;

function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function showError(message = '', scope = 'action') {
    const target = document.querySelector('#error');
    target.textContent = message;
    target.hidden = !message;
    target.dataset.scope = scope;
}
function markdownBody(className, text) {
    const body = element('div', `${className} markdown`);
    body.append(renderMarkdown(text, openMarkdownLink));
    return body;
}
// Sandboxed MCP Apps cannot open normal target=_blank links themselves.
// Delegate user-activated links to the host; never open links during rendering.
async function openMarkdownLink(event) {
    const link = event.target.closest?.('.markdown a[href]');
    if (!link || !app || (event.type === 'auxclick' && event.button !== 1)) return;
    event.preventDefault();
    event.stopPropagation();
    const url = link.href;
    if (!linkTarget(url)) return;
    try {
        const result = await app.openLink({ url }, { timeout: 5000 });
        if (result.isError) throw new Error('宿主未允许打开此链接');
        // Some hosts acknowledge file URLs without opening an editor. Keep the
        // actual destination visible instead of claiming the file was opened.
        if (url.startsWith('file:')) showError(`已请求宿主打开本地文件。若未打开，可复制路径：${decodeURI(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1')}${new URL(url).hash}`, 'link-info');
        else showError();
    } catch (error) {
        showError(`链接未打开：${error.message}。可复制地址：${url}`);
    }
}

function disclosureSummary(text, leadingIcon) {
    const summary = element('summary');
    if (leadingIcon) {
        const leading = element('i');
        leading.dataset.lucide = leadingIcon;
        summary.append(leading);
    }
    const icon = element('i');
    icon.dataset.lucide = 'chevron-down';
    icon.dataset.disclosure = 'true';
    const label = element('span', 'disclosure-label', text);
    summary.title = text;
    summary.append(label, icon);
    return summary;
}
function lazyDetails(details, renderBody) {
    function mountBody() {
        if (!details.open || details.dataset.mounted) return;
        details.dataset.mounted = 'true';
        details.append(renderBody());
        renderTimelineIcons(details);
    }
    details.addEventListener('toggle', mountBody);
    mountBody();
    return details;
}
function renderTimelineIcons(root) {
    createIcons({ icons: { ChevronDown, Pencil, Terminal, FileSearch }, root, attrs: { class: 'ui-icon', width: 16, height: 16, 'aria-hidden': 'true', focusable: 'false' } });
}
function renderTool(item, expanded) {
    const details = element('details', 'tool');
    details.dataset.id = item.id;
    details.dataset.status = item.status;
    details.open = expanded.has(item.id);
    const editing = ['edit', 'delete', 'move'].includes(item.kind);
    const verb = editing ? '编辑' : item.kind === 'read' || item.kind === 'search' ? '读取' : '运行';
    const status = item.status === 'completed' ? `已${verb}` : item.status === 'failed' ? `${verb}失败` : `正在${verb}`;
    details.append(disclosureSummary(`${status} ${item.title || item.name || '工具调用'}`, editing ? 'pencil' : verb === '读取' ? 'file-search' : 'terminal'));
    return lazyDetails(details, function toolBody() {
        return element('pre', '', toolOutput(item) || (item.status === 'completed' ? '已完成，未返回文本输出' : item.status === 'failed' ? '工具执行失败，未返回文本输出' : '等待工具输出…'));
    });
}
async function invoke(name, args = {}) {
    if (app) {
        const result = await app.callServerTool({ name, arguments: args }, name === 'panel_sync' ? { timeout: 15000 } : undefined);
        if (result.isError) throw new Error(result.content?.[0]?.text || '工具调用失败');
        return result.structuredContent || JSON.parse(result.content[0].text);
    }
    const response = await fetch('/tool', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, arguments: args }), signal: name === 'panel_sync' ? AbortSignal.timeout(15000) : undefined });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '连接失败');
    return result;
}
function modelLabel(agent) {
    const option = agent?.configOptions?.find((item) => item.id === 'model');
    return option?.options?.find((item) => item.value === option.currentValue)?.name || option?.currentValue || '模型未返回';
}
function renderList() {
    const nav = document.querySelector('#agents');
    const query = document.querySelector('#search').value.trim().toLowerCase();
    const matches = agents.filter((agent) => agent.name.toLowerCase().includes(query) && (filter === 'archive' ? agent.status === 'closed' : agent.status !== 'closed'));
    // Preserve focused controls and avoid replacing identical rows every poll.
    const key = JSON.stringify(matches.map((agent) => [agent.id, agent.name, agent.status, selected === agent.id]));
    if (nav.dataset.key === key) return;
    nav.dataset.key = key;
    nav.replaceChildren();
    for (const agent of matches) {
        const button = element('button', 'agent-row');
        button.setAttribute('aria-current', String(selected === agent.id));
        button.setAttribute('aria-label', agent.name);
        button.title = `${agent.name} · ${states[agent.status] || agent.status}`;
        const dot = element('span', 'status-dot');
        dot.dataset.status = agent.status;
        dot.setAttribute('aria-hidden', 'true');
        const copy = element('span');
        copy.append(element('span', 'agent-name', agent.name), element('span', 'sr-only', states[agent.status] || agent.status));
        button.append(dot, copy);
        button.onclick = function selectAgent() {
            if (selected === agent.id) return;
            selected = agent.id;
            state = undefined;
            dismissMessage();
            document.querySelector('#permissions').hidden = true;
            updateComposer();
            generation++;
            rendered = '';
            document.querySelector('#prompt').value = '';
            previewing = false;
            updatePreview();
            renderList();
            void refresh();
        };
        nav.append(button);
    }
    if (!matches.length) nav.append(element('p', 'empty-list', agents.length ? '没有匹配的会话' : '尚无子代理'));
}
function renderConversation(agent) {
    const container = document.querySelector('#conversation');
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 70;
    const scroll = container.scrollTop;
    const expanded = new Set([...container.querySelectorAll('details[open]')].map((node) => node.dataset.id));
    const previousThoughts = new Map([...container.querySelectorAll('details.thought')].map((node) => [node.dataset.id, { open: node.open, streaming: node.dataset.streaming === 'true' }]));
    const items = groupConsecutiveTools(projectEvents(agent.events, agent));
    container.replaceChildren();
    for (const item of items) {
        if (item.type === 'thought') {
            const details = element('details', 'thought');
            details.dataset.id = item.id;
            details.open = thoughtOpenState(item.streaming, previousThoughts.get(item.id));
            details.dataset.streaming = String(Boolean(item.streaming));
            const label = item.unavailable ? `思考 · ${item.tokens} tokens · 上游未返回片段` : item.streaming ? '思考中' : '思考过程';
            details.append(disclosureSummary(label));
            container.append(lazyDetails(details, function thoughtBody() {
                return markdownBody('thought-body', item.unavailable ? '代理返回了思考 token 用量，但本轮 ACP 事件中没有思考文本。这里仅展示上游实际返回的内容。' : item.text);
            }));
        } else if (item.type === 'tool') {
            container.append(renderTool(item, expanded));
        } else if (item.type === 'tool-group') {
            const details = element('details', 'tool-group');
            details.dataset.id = item.id;
            details.open = expanded.has(item.id);
            const completed = item.children.filter((tool) => tool.status === 'completed').length;
            const failed = item.children.filter((tool) => tool.status === 'failed').length;
            const running = item.children.length - completed - failed;
            const counts = [`工具调用 · ${item.children.length} 项`, running && `${running} 执行中`, failed && `${failed} 失败`, completed && `${completed} 已完成`].filter(Boolean);
            details.dataset.status = failed ? 'failed' : running ? 'in_progress' : 'completed';
            details.append(disclosureSummary(counts.join(' · '), item.children.some((tool) => tool.kind === 'edit') ? 'pencil' : 'terminal'));
            container.append(lazyDetails(details, function groupBody() {
                const children = element('div', 'tool-group-items');
                for (const tool of item.children) children.append(renderTool(tool, expanded));
                return children;
            }));
        } else if (item.type === 'end') {
            const usage = item.usage?.totalTokens ? ` · ${item.usage.totalTokens.toLocaleString()} tokens` : '';
            container.append(element('div', 'turn-end', item.text + usage));
        } else {
            const message = element('div', `message ${item.type}`);
            message.append(element('div', 'message-label', item.type === 'user' ? '任务指令' : item.type === 'assistant' ? '子代理' : '执行提示'), ['user', 'assistant'].includes(item.type) ? markdownBody('message-body', item.text) : element('div', 'message-body', item.text));
            container.append(message);
        }
    }
    if (!items.length) {
        const empty = element('div', 'empty');
        empty.append(element('strong', '', agent.status === 'closed' ? '会话已关闭' : '子代理已就绪'), element('span', '', agent.status === 'closed' ? '此会话没有对话记录。' : '在下方发送任务，执行进度会显示在这里。'));
        container.append(empty);
    }
    renderTimelineIcons(container);
    container.scrollTop = nearBottom ? container.scrollHeight : scroll;
}
function renderDiagnostics(agent) {
    const container = document.querySelector('#diagnostics');
    container.replaceChildren();
    const list = element('dl');
    for (const [name, value] of [['会话', agent.sessionId || '—'], ['工作目录', agent.cwd], ['连接方式', app ? 'MCP App' : '内置浏览器'], ['协议', `ACP ${agent.info?.protocolVersion || '—'}`], ['事件数量', agent.cursor]]) {
        list.append(element('dt', '', name), element('dd', '', String(value)));
    }
    const details = element('details');
    details.append(element('summary', '', '原始事件'));
    container.append(list, lazyDetails(details, function diagnosticBody() { return element('pre', '', JSON.stringify(agent.events, null, 4)); }));
}
function renderPermissions(agent) {
    const container = document.querySelector('#permissions');
    const pending = agent.pendingPermissions || [];
    container.hidden = !pending.length;
    const key = JSON.stringify([agent.id, pending]);
    if (container.dataset.key === key) return;
    container.dataset.key = key;
    container.replaceChildren();
    for (const permission of pending) {
        const card = element('div', 'permission-card');
        const tool = permission.toolCall || {};
        card.append(element('h3', '', '等待操作审批'), element('p', 'permission-title', tool.title || tool.toolCallId || '代理请求权限'));
        // Agent-authored titles are only labels; show the full request before its choices.
        const details = element('details');
        details.open = true;
        details.append(element('summary', '', `操作详情 · ${tool.kind || '未提供类型'}`), element('pre', '', JSON.stringify(tool, null, 4)));
        card.append(details);
        if (permission.options?.some((option) => option.kind.endsWith('_always'))) card.append(element('p', 'usage-note', '“始终”类选项的记忆范围由 Agent 决定。'));
        const choices = element('div', 'permission-actions');
        for (const option of permission.options || []) {
            const kinds = { allow_once: '允许一次', allow_always: '持续允许', reject_once: '拒绝一次', reject_always: '持续拒绝' };
            const button = element('button', 'secondary', `${kinds[option.kind] || '选择'} · ${option.name}`);
            button.dataset.kind = option.kind;
            button.onclick = function answerPermission() {
                return performAction(async function approve() { await invoke('agent_approve', { id: agent.id, requestId: permission.id, optionId: option.optionId }); });
            };
            choices.append(button);
        }
        const cancel = element('button', 'secondary', '取消请求');
        cancel.onclick = function cancelPermission() {
            return performAction(async function decline() { await invoke('agent_approve', { id: agent.id, requestId: permission.id }); });
        };
        const stop = element('button', 'secondary', '停止任务');
        stop.onclick = function stopBlockedTurn() {
            return performAction(async function cancelTurn() { await invoke('agent_cancel', { id: agent.id }); });
        };
        choices.append(cancel, stop);
        card.append(choices);
        container.append(card);
    }
}

function renderComposition(segments, label) {
    const wrapper = element('div', 'composition');
    const bar = element('div', 'composition-bar');
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', `${label}：${segments.map((item) => `${item.label} ${tokenText(item.value)}`).join('，')}`);
    const legend = element('div', 'composition-legend');
    for (const item of segments) {
        const segment = element('span');
        segment.style.width = `${item.percent}%`;
        segment.style.background = item.color;
        segment.title = `${item.label} · ${tokenText(item.value)} · ${item.percent.toFixed(1)}%`;
        bar.append(segment);
        const entry = element('span', 'legend-entry');
        const swatch = element('i');
        swatch.style.background = item.color;
        entry.append(swatch, document.createTextNode(`${item.label} ${tokenText(item.value)}`));
        legend.append(entry);
    }
    wrapper.append(bar, legend);
    return wrapper;
}
function updateComposer() {
    document.querySelector('#composer').hidden = state?.status === 'closed' || currentView !== 'conversation';
    document.querySelector('#closed-hint').hidden = state?.status !== 'closed';
    const ready = state && ['idle', 'completed', 'cancelled'].includes(state.status) && !actionPending;
    document.querySelector('#prompt').disabled = !ready;
    document.querySelector('#send').disabled = !ready || !document.querySelector('#prompt').value.trim();
    document.querySelector('#cancel').hidden = !['running', 'blocked'].includes(state?.status);
    document.querySelector('#cancel').disabled = actionPending;
    document.querySelector('#create').disabled = actionPending;
    document.querySelector('#archive').disabled = !state || !['idle', 'completed', 'cancelled', 'error'].includes(state.status) || actionPending;
    document.querySelector('#archive').hidden = state?.status === 'closed';
    for (const button of document.querySelectorAll('#permissions button')) button.disabled = actionPending;
    document.querySelector('#composer-hint').textContent = state?.status === 'blocked' ? '等待上方操作审批' : state?.status === 'running' ? '代理正在执行任务' : state?.status === 'closed' ? '会话已关闭，历史记录仍可查看' : ready ? '支持 Markdown · Ctrl+Enter 发送' : '选择一个可用会话';
    document.querySelector('#preview-toggle').disabled = !ready;
    for (const button of document.querySelectorAll('[data-usage-command]')) button.disabled = !ready || !state?.availableCommands?.some((item) => item.name === button.dataset.usageCommand);
    resizeComposer();
}
function updatePreview() {
    const input = document.querySelector('#prompt');
    const preview = document.querySelector('#prompt-preview');
    const toggle = document.querySelector('#preview-toggle');
    input.hidden = previewing;
    preview.hidden = !previewing;
    toggle.textContent = previewing ? '编辑' : '预览';
    toggle.setAttribute('aria-pressed', String(previewing));
    if (previewing) preview.replaceChildren(renderMarkdown(input.value || '*暂无内容*', openMarkdownLink));
    resizeComposer();
}
function resizeComposer() {
    const input = document.querySelector('#prompt');
    if (!input.offsetParent) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(160, Math.max(44, input.scrollHeight))}px`;
}
function tokenText(value) {
    return Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未返回';
}
function usageCard(label, value) {
    const card = element('div', 'usage-card');
    card.append(element('span', 'usage-label', label), element('strong', '', value));
    return card;
}
function usageSection(title) {
    const section = element('section', 'usage-section');
    section.append(element('h3', '', title));
    return section;
}
function reportTime(report) {
    return report?.at ? `${new Date(report.at).toLocaleTimeString('zh-CN', { hour12: false })} 查询${report.stale ? ' · 已有新对话，可刷新' : ''}` : '尚未查询';
}
function reportTable(table) {
    const wrapper = element('div', 'usage-table');
    const node = element('table');
    const head = element('thead');
    const row = element('tr');
    for (const text of table.headers) row.append(element('th', '', text));
    head.append(row);
    const body = element('tbody');
    for (const cells of table.rows) {
        const row = element('tr');
        for (const text of cells) row.append(element('td', '', text));
        body.append(row);
    }
    node.append(head, body);
    wrapper.append(node);
    return wrapper;
}
function renderUsage(agent) {
    const container = document.querySelector('#usage');
    const opened = new Set([...container.querySelectorAll('details[open]')].map((item) => item.dataset.report));
    const summary = usageState;
    const { session, reports } = summary;
    const strip = document.querySelector('#usage-strip');
    strip.replaceChildren(element('span', '', Number.isFinite(session.totalTokens) ? `累计 ${session.approximate ? '约 ' : ''}${tokenText(session.totalTokens)} tokens` : '累计用量未返回'), element('span', '', summary.context ? `上下文 ${(summary.context.used / summary.context.size * 100).toFixed(1)}%` : '上下文未返回'));
    const actions = element('div', 'usage-actions');
    for (const [name, label] of [['usage', '刷新用量'], ['context', '刷新上下文']]) {
        const button = element('button', 'secondary', label);
        button.dataset.usageCommand = name;
        button.disabled = !summary.commands.includes(name) || !['idle', 'completed', 'cancelled'].includes(agent.status) || actionPending;
        button.title = summary.commands.includes(name) ? `查询 /${name} 并更新本页` : `此 Agent 未提供 /${name}`;
        button.onclick = function queryReport() { return sendCommand(agent.id, name); };
        actions.append(button);
    }
    container.replaceChildren(actions);
    const totals = usageSection('会话累计');
    totals.append(element('p', 'usage-note', session.fromReport ? `来自 /usage 报告${session.approximate ? ' · 缩写数字按估算显示' : ''}` : `${session.turns} 轮对话 · tokens`));
    const grid = element('div', 'usage-grid');
    for (const [label, key] of [['总 tokens', 'totalTokens'], ['输入', 'inputTokens'], ['输出', 'outputTokens'], ['缓存读取', 'cachedReadTokens']]) grid.append(usageCard(label, tokenText(session[key])));
    const hitRate = cacheHitRate(session);
    grid.append(usageCard('缓存命中率', hitRate === null ? '未返回' : `${hitRate.toFixed(1)}%`));
    totals.append(grid);
    totals.append(element('p', 'usage-note', '缓存命中率 = 缓存读取 ÷（未缓存输入 + 缓存读取 + 缓存写入）；不含输出。缺失字段或无输入时不估算。'));
    const composition = tokenComposition(session);
    if (composition.segments.length) totals.append(renderComposition(composition.segments, '已知 token 构成'), element('p', 'usage-note', `已知 token 构成${composition.partial ? ' · 部分类型未返回' : ''}。思考已包含在输出中。`));
    const extra = element('div', 'usage-grid');
    const cost = summary.cost ? `${Number(summary.cost.amount).toLocaleString('zh-CN', { maximumFractionDigits: 6 })} ${summary.cost.currency}` : reports.usage?.reportedCost || '未返回';
    extra.append(usageCard('代理上报费用', cost), usageCard('API 耗时', reports.usage?.apiTime || '未返回'), usageCard('会话活跃时间', reports.usage?.activeTime || '未返回'));
    totals.append(extra, element('p', 'usage-note', `耗时来自 /usage · ${reportTime(reports.usage)}。费用为代理上报值。`));
    container.append(totals);
    const context = usageSection('上下文窗口');
    if (summary.context) {
        const { used, size } = summary.context;
        const headline = element('div', 'context-headline');
        headline.append(element('strong', '', `${(used / size * 100).toFixed(1)}%`), element('span', '', `${tokenText(used)} / ${tokenText(size)} tokens`));
        const progress = element('progress');
        progress.max = size;
        progress.value = used;
        progress.setAttribute('aria-label', '上下文窗口占用');
        context.append(headline, progress, element('p', 'usage-note', '代理上报的当前上下文占用。'));
    } else context.append(element('p', 'usage-note', '此 Agent 尚未返回上下文占用与窗口上限。'));
    if (reports.context?.categories.length) {
        const labels = { 'System prompt': '系统提示', 'System tools': '系统工具', 'MCP server instructions': 'MCP 指令', 'MCP tools (deferred)': 'MCP 工具（按需加载）', 'System tools (deferred)': '系统工具（按需加载）', 'Memory files': '记忆文件', 'Skills': '技能', 'Messages': '消息', 'Free space': '剩余空间' };
        context.append(element('h4', '', '分类估算'));
        const estimate = reports.context.contextEstimate;
        context.append(element('p', 'usage-note', `${estimate ? `报告估算 ${tokenText(estimate.used)} / ${tokenText(estimate.size)} tokens · ` : ''}${reportTime(reports.context)}。按需加载项可能不计入当前占用。`));
        const palette = ['#6495ed', '#a78bfa', '#54b995', '#e8ad50', '#e184a0', '#52b6cc', '#9ba66b'];
        const categories = reports.context.categories.filter((item) => !/deferred|Free space/i.test(item.name) && Number.isFinite(item.tokens) && item.tokens >= 0);
        const categoryTotal = categories.reduce((sum, item) => sum + item.tokens, 0);
        if (categoryTotal) {
            context.append(renderComposition(categories.map((item, index) => ({ label: labels[item.name] || item.name, value: item.tokens, percent: item.tokens / categoryTotal * 100, color: palette[index % palette.length] })), '分类估算构成'));
            context.append(element('p', 'usage-note', '色条表示已列出类别的相对构成，不代表窗口占比；不含按需加载项与剩余空间。'));
        }
        const rows = element('div', 'context-categories');
        for (const category of reports.context.categories) {
            const row = element('div', 'category-row');
            row.append(element('span', '', labels[category.name] || category.name), element('span', '', `${tokenText(category.tokens)}${category.percent === null ? '' : ` · ${category.percent}%`}`));
            if (category.percent !== null) {
                const meter = element('progress');
                meter.max = 100;
                meter.value = category.percent;
                meter.setAttribute('aria-label', labels[category.name] || category.name);
                row.append(meter);
            }
            rows.append(row);
        }
        context.append(rows);
    }
    container.append(context);
    const latest = usageSection('最近一轮对话');
    const list = element('dl');
    for (const [label, key] of [['输入', 'inputTokens'], ['输出', 'outputTokens'], ['思考', 'thoughtTokens'], ['缓存读取', 'cachedReadTokens'], ['缓存写入', 'cachedWriteTokens'], ['合计', 'totalTokens']]) list.append(element('dt', '', label), element('dd', '', tokenText(summary.turn?.[key])));
    latest.append(list);
    container.append(latest);
    const quota = usageSection('账号配额');
    const quotaTables = (reports.usage?.tables || []).filter((table) => /quota|limit|plan|account|weekly|daily|配额|限额/i.test(table.title));
    if (quotaTables.length) for (const table of quotaTables) quota.append(element('h4', '', table.title), reportTable(table));
    else quota.append(element('p', 'usage-note', reports.usage ? '此 Agent 返回了会话统计，但没有返回账号额度或重置时间。' : summary.commands.includes('usage') ? '刷新用量后显示代理实际提供的额度信息。' : '此 Agent 未提供账号配额查询。'));
    container.append(quota);
    // Keep detailed command tables inspectable as UI tables, without flooding the summary.
    for (const [kind, report] of Object.entries(reports)) {
        for (const [index, table] of report.tables.entries()) {
            if (kind === 'context' && table.headers.includes('Category')) continue;
            if (quotaTables.includes(table)) continue;
            const details = element('details', 'usage-report');
            details.dataset.report = `${kind}:${index}`;
            details.open = opened.has(details.dataset.report);
            details.append(element('summary', '', `${table.title || '统计明细'} · /${kind}`), reportTable(table));
            container.append(details);
        }
    }
}
function sendCommand(id, command) {
    return performAction(async function sendSlashCommand() {
        await invoke('agent_send', { id, prompt: `/${command}` });
        document.querySelector('[data-view="usage"]').click();
    });
}
async function refresh() {
    clearTimeout(pollTimer);
    if (!pageActive || document.hidden) return;
    if (refreshing) { pendingRefresh = true; return; }
    refreshing = true;
    const version = generation;
    try {
        const result = await invoke('panel_sync', panelSyncArgs(state, selected, listRevision));
        if (generation !== version) { pendingRefresh = true; return; }
        if (result.agents) agents = result.agents;
        listRevision = result.revision;
        const visible = agents.filter((agent) => filter === 'archive' ? agent.status === 'closed' : agent.status !== 'closed');
        if (!visible.some((agent) => agent.id === selected)) {
            dismissMessage();
            selected = visible[0]?.id;
            state = undefined;
            rendered = '';
            document.querySelector('#prompt').value = '';
            previewing = false;
            updatePreview();
        }
        document.querySelector('#count').textContent = visible.length;
        document.querySelector('#connection').textContent = '已连接';
        renderList();
        if (selected) {
            const id = selected;
            if (result.agent?.id !== id && !state) { pendingRefresh = true; return; }
            const agent = mergePanelState(state, result.agent?.id === id ? result.agent : undefined);
            // A selection change invalidates all in-flight detail responses.
            if (generation !== version || selected !== id) return;
            // Baseline the full source cursor once, so paged history and session
            // switches never replay old recovery toasts. Deltas show only the latest.
            if (!state) recoveryNoticeAfter = agent.sourceCursor;
            else {
                const message = recoveryMessage(result.agent?.events, recoveryNoticeAfter);
                if (message) showMessage(message);
                recoveryNoticeAfter = Math.max(recoveryNoticeAfter, agent.cursor);
            }
            state = agent;
            const key = `${agent.id}:${agent.cursor}:${agent.status}`;
            if (rendered !== key) {
                document.querySelector('#agent-title').textContent = agent.name;
                const effort = agent.configOptions?.find((item) => item.category === 'thought_level' || ['effort', 'thought_level'].includes(item.id));
                document.querySelector('#agent-meta').textContent = `${agent.provider === 'claude' ? 'Claude Code' : 'Antigravity'} · ${modelLabel(agent)}${effort ? ` · 思考 ${effort.currentValue}` : ''}`;
                const badge = document.querySelector('#agent-state');
                badge.hidden = false;
                badge.textContent = '';
                badge.title = states[agent.status] || agent.status;
                badge.setAttribute('aria-label', badge.title);
                badge.dataset.status = agent.status;
                usageState = usageSummary(agent);
                const session = usageState.session;
                document.querySelector('#usage-strip').replaceChildren(element('span', '', Number.isFinite(session.totalTokens) ? `累计 ${session.approximate ? '约 ' : ''}${tokenText(session.totalTokens)} tokens` : '累计用量未返回'), element('span', '', usageState.context ? `上下文 ${(usageState.context.used / usageState.context.size * 100).toFixed(1)}%` : '上下文未返回'));
                // Hidden tabs retain no heavy transcript/JSON DOM from another session.
                for (const view of ['conversation', 'usage', 'diagnostics']) {
                    if (!viewKeys[view]?.startsWith(`${agent.id}:`)) {
                        document.getElementById(view).replaceChildren();
                        delete viewKeys[view];
                    }
                }
                renderPermissions(agent);
                rendered = key;
            }
            renderActiveView();
            updateComposer();
        } else {
            state = undefined;
            rendered = '';
            document.querySelector('#agent-title').textContent = filter === 'archive' ? '暂无归档会话' : '暂无会话';
            document.querySelector('#agent-meta').textContent = '点击 + 创建子代理';
            document.querySelector('#agent-state').hidden = true;
            for (const id of ['conversation', 'usage', 'usage-strip', 'diagnostics', 'permissions']) document.getElementById(id).replaceChildren();
            for (const view of Object.keys(viewKeys)) delete viewKeys[view];
            document.querySelector('#permissions').hidden = true;
            delete document.querySelector('#permissions').dataset.key;
            updateComposer();
        }
        if (document.querySelector('#error').dataset.scope === 'connection') showError();
        failures = 0;
    } catch (error) {
        failures++;
        document.querySelector('#connection').textContent = '连接中断';
        showError(error.message, 'connection');
    } finally {
        refreshing = false;
        if (pendingRefresh && !document.hidden && pageActive) { pendingRefresh = false; void refresh(); }
        else scheduleRefresh();
    }
}
function renderActiveView() {
    if (!state || viewKeys[currentView] === rendered) return;
    if (currentView === 'conversation') renderConversation(state);
    else if (currentView === 'usage') renderUsage(state);
    else renderDiagnostics(state);
    viewKeys[currentView] = rendered;
}
function scheduleRefresh() {
    clearTimeout(pollTimer);
    const delay = pollDelay({ hidden: document.hidden || !pageActive, hasMore: state?.hasMore, active: agents.some((agent) => ['starting', 'configuring', 'running', 'blocked', 'cancelling'].includes(agent.status)), failures });
    if (delay !== null) pollTimer = setTimeout(refresh, delay);
}
document.addEventListener('visibilitychange', function visibilityChanged() {
    if (document.hidden) clearTimeout(pollTimer);
    else void refresh();
});
window.addEventListener('pagehide', function pageHidden() { pageActive = false; clearTimeout(pollTimer); });
window.addEventListener('pageshow', function pageShown() { pageActive = true; void refresh(); });
async function performAction(action) {
    if (actionPending) return;
    actionPending = true;
    updateComposer();
    let failure;
    try { await action(); showError(); }
    catch (error) { failure = error.message; }
    finally {
        actionPending = false;
        updateComposer();
        await refresh();
        if (failure) showError(failure);
    }
}
document.querySelector('#refresh').onclick = refresh;
document.querySelector('#search').oninput = renderList;
document.querySelector('#prompt').oninput = updateComposer;
document.querySelector('#preview-toggle').onclick = function togglePreview() {
    previewing = !previewing;
    updatePreview();
    if (!previewing) document.querySelector('#prompt').focus();
};
new ResizeObserver(resizeComposer).observe(document.querySelector('#composer'));
document.querySelector('#prompt').onkeydown = function submitShortcut(event) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !document.querySelector('#send').disabled) {
        event.preventDefault();
        document.querySelector('#composer').requestSubmit();
    }
};
for (const button of document.querySelectorAll('[data-filter]')) button.onclick = function changeFilter() {
    dismissMessage();
    filter = button.dataset.filter;
    selected = undefined;
    state = undefined;
    generation++;
    rendered = '';
    document.querySelector('#prompt').value = '';
    previewing = false;
    updatePreview();
    for (const item of document.querySelectorAll('[data-filter]')) item.setAttribute('aria-pressed', String(item === button));
    renderList();
    updateComposer();
    void refresh();
};
for (const button of document.querySelectorAll('[data-view]')) button.onclick = function changeView() {
    currentView = button.dataset.view;
    renderActiveView();
    for (const item of document.querySelectorAll('[data-view]')) item.setAttribute('aria-pressed', String(item === button));
    document.querySelector('#conversation').hidden = button.dataset.view !== 'conversation';
    document.querySelector('#diagnostics').hidden = button.dataset.view !== 'diagnostics';
    document.querySelector('#usage').hidden = button.dataset.view !== 'usage';
    updateComposer();
};
const sessionSetup = createSessionSetup(invoke);
document.querySelector('#create').onclick = function createAgent() {
    return performAction(async function spawn() {
        const agent = await sessionSetup.open(`子代理 ${agents.length + 1}`);
        if (!agent) return;
        filter = 'current';
        document.querySelector('#search').value = '';
        for (const item of document.querySelectorAll('[data-filter]')) item.setAttribute('aria-pressed', String(item.dataset.filter === filter));
        selected = agent.id;
        state = undefined;
        generation++;
        rendered = '';
        document.querySelector('#prompt').value = '';
        previewing = false;
        updatePreview();
        document.querySelector('[data-view="conversation"]').click();
    });
};
document.querySelector('#cancel').onclick = function cancelAgent() {
    return performAction(async function cancel() { await invoke('agent_cancel', { id: selected }); });
};
document.querySelector('#archive').onclick = function archiveAgent() {
    return performAction(async function close() { await invoke('agent_close', { id: selected }); });
};
document.querySelector('#composer').onsubmit = function sendPrompt(event) {
    event.preventDefault();
    const prompt = document.querySelector('#prompt').value.trim();
    if (!prompt || document.querySelector('#send').disabled) return;
    return performAction(async function send() {
        await invoke('agent_send', { id: selected, prompt });
        document.querySelector('#prompt').value = '';
        previewing = false;
        updatePreview();
    });
};
if (app) {
    app.onhostcontextchanged = function updateTheme(context) {
        if (context.theme) document.documentElement.dataset.theme = context.theme;
    };
    await app.connect();
    const context = app.getHostContext();
    if (context?.theme) document.documentElement.dataset.theme = context.theme;
}
await refresh();
