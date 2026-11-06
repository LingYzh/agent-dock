import { Lexer } from 'marked';

const tokenFields = ['inputTokens', 'outputTokens', 'thoughtTokens', 'cachedReadTokens', 'cachedWriteTokens', 'totalTokens'];
const inputFields = ['inputTokens', 'cachedReadTokens', 'cachedWriteTokens'];

export function cacheHitRate(usage) {
    if (usage.cacheInputComplete === false || !inputFields.every((key) => Number.isFinite(usage[key]) && usage[key] >= 0)) return null;
    const totalInput = inputFields.reduce((sum, key) => sum + usage[key], 0);
    return totalInput > 0 ? usage.cachedReadTokens / totalInput * 100 : null;
}

// A composition bar describes known components, not account quota or context occupancy.
// Thought tokens are part of output and must not be counted a second time.
export function tokenComposition(usage) {
    const fields = [['inputTokens', '输入', '#6495ed'], ['outputTokens', '输出', '#a78bfa'], ['cachedReadTokens', '缓存读取', '#54b995'], ['cachedWriteTokens', '缓存写入', '#e8ad50']];
    const segments = fields.map(([key, label, color]) => ({ key, label, color, value: usage[key] })).filter((item) => Number.isFinite(item.value) && item.value >= 0);
    const total = segments.reduce((sum, item) => sum + item.value, 0);
    return { total, partial: segments.length < fields.length, segments: segments.map((item) => ({ ...item, percent: total ? item.value / total * 100 : 0 })) };
}

function plain(text) {
    return String(text || '').replace(/\*\*|`/g, '').trim();
}

export function parseTokenCount(text) {
    const match = String(text).replace(/,/g, '').trim().match(/^(\d+(?:\.\d+)?)\s*([km])?$/i);
    return match ? Math.round(Number(match[1]) * ({ k: 1000, m: 1000000 }[match[2]?.toLowerCase()] || 1)) : null;
}

export function parseUsageReport(text, at) {
    let section = '';
    const tables = [];
    const seen = new Set();
    // Only invoked for completed /usage or /context turns, never arbitrary model prose.
    for (const token of Lexer.lex(text)) {
        if (token.type === 'heading') section = plain(token.text);
        if (token.type !== 'table') continue;
        const table = { title: section, headers: token.header.map((cell) => plain(cell.text)), rows: token.rows.map((row) => row.map((cell) => plain(cell.text))) };
        const key = JSON.stringify(table);
        // Some adapters emit their complete local-command output twice.
        if (!seen.has(key)) tables.push(table);
        seen.add(key);
    }
    const tokens = plain(text).match(/Tokens:\s*([\d.,]+\s*[km]?)\s*\/\s*([\d.,]+\s*[km]?)/i);
    const timing = tables.find((table) => table.headers.includes('API time'));
    const categories = tables.find((table) => table.headers.includes('Category') && table.headers.includes('Percentage'));
    const breakdown = tables.find((table) => table.headers[0] === 'Breakdown' && table.headers[1] === 'Tokens');
    const reportedTokens = {};
    const tokenNames = { Input: 'inputTokens', Output: 'outputTokens', 'Cache read': 'cachedReadTokens', 'Cache write': 'cachedWriteTokens' };
    for (const [label, count] of breakdown?.rows || []) {
        const value = parseTokenCount(count);
        if (tokenNames[label] && value !== null) reportedTokens[tokenNames[label]] = value;
    }
    const reportedValues = Object.values(tokenNames).map((key) => reportedTokens[key]);
    if (reportedValues.every(Number.isFinite)) reportedTokens.totalTokens = reportedValues.reduce((total, value) => total + value, 0);
    return {
        at, tables, reportedTokens,
        approximateTokens: Boolean(breakdown?.rows.some((row) => /[km]/i.test(row[1]))),
        apiTime: timing?.rows[0]?.[timing.headers.indexOf('API time')],
        activeTime: timing?.rows[0]?.[timing.headers.indexOf('Active')],
        reportedCost: timing?.rows[0]?.[timing.headers.indexOf('Cost')],
        contextEstimate: tokens ? { used: parseTokenCount(tokens[1]), size: parseTokenCount(tokens[2]) } : null,
        categories: categories?.rows.map((row) => ({ name: row[0], tokens: parseTokenCount(row[1]), percent: /^\d+(?:\.\d+)?%$/.test(row[2]) ? Number(row[2].slice(0, -1)) : null })) || []
    };
}

export function usageSummary(agent) {
    const events = agent.events || [];
    const reports = {};
    const session = { turns: 0, cacheInputComplete: true };
    let turn;
    let turnAt;
    let command;
    let text = '';
    for (const event of events) {
        if (event.method === 'bridge/prompt') {
            command = event.params?.text?.trim().match(/^\/(usage|context)$/)?.[1];
            text = '';
        }
        if (command && event.params?.update?.sessionUpdate === 'agent_message_chunk') text += event.params.update.content?.text || '';
        if (event.method !== 'bridge/turn_end') continue;
        if (command) {
            if (event.params?.stopReason === 'end_turn' && text) reports[command] = parseUsageReport(text, event.at);
            command = undefined;
            text = '';
            continue;
        }
        if (!event.params?.usage) continue;
        turn = event.params.usage;
        turnAt = event.at;
        session.turns++;
        if (!inputFields.every((key) => Number.isFinite(turn[key]) && turn[key] >= 0)) session.cacheInputComplete = false;
        for (const key of tokenFields) {
            if (Number.isFinite(turn[key])) session[key] = (session[key] || 0) + turn[key];
        }
    }
    for (const report of Object.values(reports)) report.stale = Boolean(turnAt && report.at && turnAt > report.at);
    // Local commands may be the only usage source before the first model turn.
    if (!session.turns && reports.usage) {
        Object.assign(session, reports.usage.reportedTokens);
        session.fromReport = true;
        session.approximate = reports.usage.approximateTokens;
    }
    const context = agent.contextUsage || events.filter((event) => event.params?.update?.sessionUpdate === 'usage_update').at(-1)?.params.update;
    const commands = agent.availableCommands || events.filter((event) => event.params?.update?.sessionUpdate === 'available_commands_update').at(-1)?.params.update.availableCommands || [];
    return {
        turn, turnAt, session, reports,
        context: Number.isFinite(context?.used) && Number.isFinite(context?.size) && context.used >= 0 && context.size > 0 ? { used: context.used, size: context.size } : null,
        cost: context?.cost || events.filter((event) => event.params?.update?.sessionUpdate === 'usage_update' && event.params.update.cost).at(-1)?.params.update.cost,
        commands: commands.map((item) => item.name)
    };
}
