const overscan = 650;

// Mount only the rows around the scroll viewport. Measured heights are keyed
// by event identity, so prepending history does not move the reader's anchor.
export function createTimelineWindow(container, renderRow, rememberRow) {
    const layer = document.createElement('div');
    layer.className = 'timeline-window';
    container.replaceChildren(layer);
    let rows = [];
    let offsets = [0];
    let indexByKey = new Map();
    const heights = new Map();
    const mounted = new Map();
    let frame = 0;
    let disposed = false;
    let prependAnchor;
    let lastLayoutScroll = 0;

    function estimate(row) {
        if (['user', 'assistant', 'notice', 'error'].includes(row.type)) return 54 + Math.min(420, Math.ceil((row.text?.length || 0) / 60) * 18);
        return row.type === 'empty' ? 115 : 42;
    }
    function padding() {
        return parseFloat(getComputedStyle(container).paddingTop) || 0;
    }
    function indexAt(position) {
        let low = 0;
        let high = rows.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (offsets[mid + 1] <= position) low = mid + 1;
            else high = mid;
        }
        return low;
    }
    function anchor(prepend = false) {
        if (!rows.length || (!prepend && container.scrollHeight - container.scrollTop - container.clientHeight < 70)) return { tail: true };
        const position = container.scrollTop - padding();
        let index = Math.min(indexAt(position), rows.length - 1);
        if (prepend && rows[index]?.type === 'history' && rows[index + 1]) index++;
        return { key: rows[index]?.key, offset: position - offsets[index], scroll: container.scrollTop };
    }
    function layout(saved) {
        offsets = [0];
        for (const row of rows) offsets.push(offsets.at(-1) + (heights.get(row.key) ?? estimate(row)));
        layer.style.height = `${offsets.at(-1)}px`;
        if (saved.tail) container.scrollTop = container.scrollHeight;
        else {
            const index = indexByKey.get(saved.key);
            container.scrollTop = index === undefined ? saved.scroll : padding() + offsets[index] + saved.offset;
        }
        lastLayoutScroll = container.scrollTop;
    }
    function unmount(key, element) {
        rememberRow(element);
        observer.unobserve(element);
        element.remove();
        mounted.delete(key);
    }
    function renderWindow() {
        frame = 0;
        if (disposed || !container.clientHeight) return;
        const scroll = container.scrollTop - padding();
        const from = indexAt(Math.max(0, scroll - overscan));
        const to = Math.min(rows.length, indexAt(scroll + container.clientHeight + overscan) + 1);
        const visible = new Set(rows.slice(from, to).map((row) => row.key));
        for (const [key, element] of mounted) {
            if (!visible.has(key) && !element.contains(document.activeElement)) unmount(key, element);
        }
        for (let index = from; index < to; index++) {
            const row = rows[index];
            let element = mounted.get(row.key);
            if (!element) {
                element = document.createElement('div');
                element.className = 'timeline-row';
                element.dataset.rowKey = row.key;
                element.append(renderRow(row));
                const next = [...layer.children].find((child) => indexByKey.get(child.dataset.rowKey) > index);
                layer.insertBefore(element, next ?? null);
                mounted.set(row.key, element);
                observer.observe(element);
            }
            element.style.top = `${offsets[index]}px`;
        }
    }
    function schedule() {
        if (!disposed && !frame) frame = requestAnimationFrame(renderWindow);
    }
    function onScroll() {
        if (Math.abs(container.scrollTop - lastLayoutScroll) > 1) prependAnchor = undefined;
        schedule();
    }
    const observer = new ResizeObserver(function measure(entries) {
        if (disposed || !container.clientHeight) return;
        const saved = prependAnchor ?? anchor();
        let changed = false;
        for (const entry of entries) {
            const key = entry.target.dataset.rowKey;
            if (mounted.get(key) !== entry.target) continue;
            const height = entry.target.getBoundingClientRect().height;
            if (height > 0 && Math.abs((heights.get(key) ?? 0) - height) > 0.5) {
                heights.set(key, height);
                changed = true;
            }
        }
        if (changed) layout(saved);
        schedule();
    });
    observer.observe(container);
    container.addEventListener('scroll', onScroll, { passive: true });
    return {
        update(items, prepend) {
            const saved = anchor(prepend);
            // Newly mounted rows can report their true heights over several
            // frames. Keep the same message pinned until the reader scrolls.
            prependAnchor = prepend && saved.key ? saved : undefined;
            for (const [key, element] of mounted) unmount(key, element);
            rows = items;
            indexByKey = new Map(rows.map((row, index) => [row.key, index]));
            layout(saved);
            schedule();
        },
        dispose() {
            disposed = true;
            cancelAnimationFrame(frame);
            observer.disconnect();
            container.removeEventListener('scroll', onScroll);
        }
    };
}
