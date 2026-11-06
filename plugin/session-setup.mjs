import { createIcons, Check, ChevronDown } from 'lucide';

function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
}

export function sessionChoice(agent, category, fallbackIds) {
    const config = agent?.configOptions?.find((item) => item.category === category) || agent?.configOptions?.find((item) => fallbackIds.includes(item.id));
    if (config?.type !== 'select') return null;
    const options = (config.options || []).flatMap((item) => item.options ? item.options.map((child) => ({ ...child, group: item.name })) : [item]);
    // Custom provider models can be the confirmed current value without a catalog entry.
    if (config.currentValue && !options.some((item) => item.value === config.currentValue)) options.unshift({ value: config.currentValue, name: config.currentValue });
    return { ...config, options };
}

// ACP exposes model-dependent choices only after session/new. Prepare one idle session,
// configure that same session, and never send a prompt before the user starts using it.
export function createSessionSetup(invoke) {
    const dialog = document.querySelector('#session-setup');
    const fields = dialog.querySelector('.setup-fields');
    const cancel = dialog.querySelector('#setup-cancel');
    const confirm = dialog.querySelector('#setup-confirm');
    const status = dialog.querySelector('#setup-status');
    const errorBox = dialog.querySelector('#setup-error');
    let agent;
    let busy = false;
    let finish;
    let provider = 'agy';
    let sessionName;

    function showError(message = '') {
        errorBox.textContent = message;
        errorBox.hidden = !message;
    }
    function setBusy(value, message = '') {
        busy = value;
        dialog.setAttribute('aria-busy', String(value));
        status.textContent = message;
        status.hidden = !message;
        cancel.disabled = value;
        confirm.disabled = value || !agent || !['idle', 'completed', 'cancelled'].includes(agent.status);
        for (const button of fields.querySelectorAll('button')) button.disabled = value;
    }
    function closeMenus() {
        for (const menu of fields.querySelectorAll('[role="listbox"]')) menu.hidden = true;
        for (const trigger of fields.querySelectorAll('[aria-haspopup="listbox"]')) trigger.setAttribute('aria-expanded', 'false');
    }
    function picker(label, property, choice) {
        const field = node('div', 'setup-field');
        const labelId = `setup-${property}-label`;
        const labelNode = node('span', 'setup-label', label);
        labelNode.id = labelId;
        field.append(labelNode);
        if (!choice?.options.length) {
            field.append(node('div', 'setup-unavailable', '由 Agent 管理，未提供可选项'));
            return field;
        }
        const wrapper = node('div', 'setup-picker');
        const trigger = node('button', 'setup-trigger');
        trigger.type = 'button';
        trigger.id = `setup-${property}`;
        trigger.setAttribute('aria-labelledby', labelId);
        trigger.setAttribute('aria-haspopup', 'listbox');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', `setup-${property}-options`);
        const selected = choice.options.find((item) => item.value === choice.currentValue);
        trigger.append(node('span', '', selected?.name || choice.currentValue));
        const chevron = node('i');
        chevron.dataset.lucide = 'chevron-down';
        trigger.append(chevron);
        const menu = node('div', 'setup-options');
        menu.id = `setup-${property}-options`;
        menu.hidden = true;
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-labelledby', labelId);
        for (const option of choice.options) {
            const button = node('button', 'setup-option');
            button.type = 'button';
            button.dataset.value = option.value;
            button.setAttribute('role', 'option');
            button.setAttribute('aria-selected', String(option.value === choice.currentValue));
            const copy = node('span', 'setup-option-copy');
            copy.append(node('span', '', option.name || option.value));
            if (option.description || option.group) copy.append(node('small', '', [option.group, option.description].filter(Boolean).join(' · ')));
            const check = node('span', 'option-check');
            const icon = node('i');
            icon.dataset.lucide = 'check';
            check.append(icon);
            button.append(copy, check);
            button.onclick = async function selectOption() {
                if (busy) return;
                closeMenus();
                if (option.value !== choice.currentValue || (property === 'provider' && !agent)) await configure(property, option.value);
                fields.querySelector(`#setup-${property}`)?.focus();
            };
            menu.append(button);
        }
        function openMenu() {
            closeMenus();
            menu.hidden = false;
            trigger.setAttribute('aria-expanded', 'true');
            menu.querySelector('[aria-selected="true"]')?.focus();
        }
        trigger.onclick = function toggleMenu() { if (menu.hidden) openMenu(); else closeMenus(); };
        trigger.onkeydown = function triggerKeyboard(event) {
            if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); openMenu(); }
        };
        menu.onkeydown = function optionKeyboard(event) {
            const options = [...menu.querySelectorAll('[role="option"]')];
            const index = options.indexOf(document.activeElement);
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                options[event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].focus();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeMenus();
                trigger.focus();
            } else if (event.key === 'Tab') closeMenus();
        };
        wrapper.append(trigger, menu);
        field.append(wrapper);
        return field;
    }
    function render() {
        fields.replaceChildren(picker('Agent', 'provider', { currentValue: provider, options: [{ value: 'agy', name: 'Antigravity' }, { value: 'claude', name: 'Claude Code' }] }), picker('模型', 'model', sessionChoice(agent, 'model', ['model'])), picker('思考强度', 'thoughtLevel', sessionChoice(agent, 'thought_level', ['thought_level', 'effort'])));
        createIcons({ root: fields, icons: { Check, ChevronDown }, attrs: { class: 'ui-icon', width: 16, height: 16, 'stroke-width': 1.75, 'aria-hidden': 'true', focusable: 'false' } });
    }
    async function configure(property, value) {
        if (property === 'provider') {
            setBusy(true, '正在切换 Agent 并读取模型选项…');
            showError();
            try {
                // Retain the old preparation if closing fails, so Cancel can retry.
                if (agent) await invoke('agent_close', { id: agent.id });
                agent = undefined;
                provider = value;
                render();
                setBusy(true, '正在读取模型与思考强度选项…');
                agent = await invoke('agent_spawn', { provider, name: sessionName });
            } catch (error) { showError(error.message); }
            finally { render(); setBusy(false); }
            return;
        }
        setBusy(true, property === 'model' ? '正在切换模型并更新可选项…' : '正在设置思考强度…');
        showError();
        try {
            agent = await invoke('agent_configure', { id: agent.id, [property]: value });
        } catch (error) {
            // Failed configuration can still apply earlier options. Re-read confirmed state.
            try { agent = await invoke('agent_get', { id: agent.id }); }
            catch { agent = { ...agent, status: 'error' }; }
            showError(error.message);
        } finally { render(); setBusy(false); }
    }
    async function dismiss() {
        if (busy) return;
        setBusy(true, '正在关闭会话…');
        try {
            if (agent) await invoke('agent_close', { id: agent.id });
            dialog.close();
            finish(null);
        } catch (error) { showError(error.message); }
        finally { setBusy(false); }
    }
    cancel.onclick = dismiss;
    confirm.onclick = function useSession() {
        if (busy || confirm.disabled) return;
        dialog.close();
        finish(agent);
    };
    dialog.oncancel = function escapeDialog(event) { event.preventDefault(); void dismiss(); };
    dialog.addEventListener('pointerdown', function outsidePicker(event) { if (!event.target.closest('.setup-picker')) closeMenus(); });

    async function open(name) {
        agent = undefined;
        sessionName = name;
        render();
        showError();
        const completion = new Promise((resolve) => { finish = resolve; });
        setBusy(true, '正在读取模型与思考强度选项…');
        dialog.showModal();
        try {
            agent = await invoke('agent_spawn', { provider, name });
            render();
        } catch (error) { showError(error.message); }
        finally { setBusy(false); }
        fields.querySelector('button')?.focus();
        return completion;
    }
    return { open };
}
