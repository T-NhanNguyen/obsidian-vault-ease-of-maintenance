// Shared markdown rendering for agent-generated text in Obsidian views.
//
// Obsidian's MarkdownRenderer is the only correct markdown path in a view:
// it applies the same pipeline as note rendering (theme, headings, lists,
// bold, line breaks). Raw text or hand-rolled HTML conversion breaks
// against Obsidian's CSS and plugins.
//
// Technical limitations handled here:
//   - ![[embed]] syntax would inline vault files into the UI — disabled.
//   - Raw HTML passes through Obsidian's pipeline — escaped, because the
//     text comes from a model API and must not inject markup.
//   - [n] citation markers would render as unresolved links — escaped,
//     then re-wrapped as styled chips via a text-node walk.

import { App, Component, MarkdownRenderer } from "obsidian";

const EMBED_SYNTAX_RE = /!\[\[/g;
const HTML_TAG_RE = /<(\/?)([a-zA-Z][^>\n]*?)>/g;
const CITATION_RE = /\[\d+\]/g;

export async function renderAgentMarkdown(
    app: App,
    component: Component,
    markdown: string,
    el: HTMLElement
): Promise<void> {
    const safe = markdown
        .replace(EMBED_SYNTAX_RE, "!\\[\\[")
        .replace(HTML_TAG_RE, "&lt;$1$2&gt;")
        .replace(CITATION_RE, "\\[$&\\]");
    await MarkdownRenderer.render(app, safe, el, "", component);
    styleCitations(el);
}

// Wrap [n] markers in a citation chip after markdown rendering. The
// renderer emits them as plain text nodes, so a text-node walk is needed.
function styleCitations(root: HTMLElement): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null = walker.nextNode();
    while (node) {
        if (node.nodeValue && CITATION_RE.test(node.nodeValue)) {
            textNodes.push(node as Text);
        }
        node = walker.nextNode();
    }
    for (const textNode of textNodes) {
        const parent = textNode.parentElement;
        if (!parent) continue;
        const fragment = document.createDocumentFragment();
        const parts = (textNode.nodeValue || "").split(/(\[\d+\])/);
        for (const part of parts) {
            if (!part) continue;
            if (/^\[\d+\]$/.test(part)) {
                const span = document.createElement("span");
                span.className = "nm-citation";
                span.textContent = part;
                fragment.appendChild(span);
            } else {
                fragment.appendChild(document.createTextNode(part));
            }
        }
        parent.replaceChild(fragment, textNode);
    }
}
