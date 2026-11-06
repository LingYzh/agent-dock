import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import { linkTarget } from './link-target.mjs';

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function escape(character) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
}

const parser = new Marked({
    gfm: true,
    breaks: true,
    renderer: {
        // Agent output is untrusted. Raw HTML stays visible text, never executable UI.
        html({ text }) { return escapeHtml(text); },
        checkbox({ checked }) { return checked ? '☑ ' : '☐ '; },
        link({ href, title, tokens }) {
            const label = this.parser.parseInline(tokens);
            const target = linkTarget(href);
            return target ? `<a href="${escapeHtml(target)}"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>` : label;
        },
        // Avoid automatic remote requests when merely viewing a conversation.
        image({ href, text }) { return `<a href="${escapeHtml(href)}">${escapeHtml(text || '图片')}</a>`; }
    }
});

export function renderMarkdown(source, onLink) {
    const fragment = DOMPurify.sanitize(parser.parse(String(source || '')), {
        RETURN_DOM_FRAGMENT: true,
        ALLOWED_TAGS: ['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a'],
        ALLOWED_ATTR: ['href', 'title', 'class', 'start', 'align'],
        ALLOW_DATA_ATTR: false,
        ALLOW_ARIA_ATTR: false,
        ALLOWED_URI_REGEXP: /^(?:https?:\/\/|mailto:|file:\/\/\/)/i
    });
    for (const link of fragment.querySelectorAll('a[href]')) {
        if (!linkTarget(link.getAttribute('href'))) {
            link.removeAttribute('href');
            continue;
        }
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        // Bind to the anchor itself: host sandbox bubbling handlers may consume
        // clicks before they reach a delegated document/body listener.
        if (onLink) {
            link.addEventListener('click', onLink);
            link.addEventListener('auxclick', onLink);
        }
    }
    for (const table of fragment.querySelectorAll('table')) {
        const wrapper = document.createElement('div');
        wrapper.className = 'markdown-table';
        table.replaceWith(wrapper);
        wrapper.append(table);
    }
    return fragment;
}
