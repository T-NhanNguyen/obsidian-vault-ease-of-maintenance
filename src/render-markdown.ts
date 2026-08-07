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
//   - [n] / [[n]] citation markers would render as unresolved links or
//     wikilinks — escaped, then re-wrapped as clickable chips via a
//     text-node walk. Chips carry data-citation-index so callers can link
//     them to a numbered source list.

import { App, Component, MarkdownRenderer } from "obsidian";

const EMBED_SYNTAX_RE = /!\[\[/g;
const HTML_TAG_RE = /<(\/?)([a-zA-Z][^>\n]*?)>/g;
// Matches both the prompt's [1] form and the model's drift to [[1]].
const CITATION_RE = /\[\[(\d+)\]\]|\[(\d+)\]/g;
const CITATION_SPLIT_RE = /(\[\[\d+\]\]|\[\d+\])/g;
const CITATION_TEST_RE = /\[\[\d+\]\]|\[\d+\]/; // non-global: walker test must not carry lastIndex

// Pure markdown pre-transform: escapes everything the renderer must treat as
// literal text (embeds, raw HTML, citation markers). Exported for unit tests.
export function escapeAgentMarkdown(markdown: string): string {
    return markdown
        .replace(EMBED_SYNTAX_RE, "!\\[\\[")
        .replace(HTML_TAG_RE, "&lt;$1$2&gt;")
        .replace(CITATION_RE, (_match, double, single) =>
            double ? `\\[\\[${double}\\]\\]` : `\\[${single}\\]`);
}

export async function renderAgentMarkdown(
    app: App,
    component: Component,
    markdown: string,
    el: HTMLElement
): Promise<void> {
    await MarkdownRenderer.render(app, escapeAgentMarkdown(markdown), el, "", component);
    styleCitations(el);
}

// Wrap citation markers in clickable chips after markdown rendering. The
// renderer emits them as plain text nodes, so a text-node walk is needed.
// Each chip carries data-citation-index + is keyboard-accessible; the caller
// decides what a jump to that source means.
function styleCitations(root: HTMLElement): void {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    let node: Node | null = walker.nextNode();
    while (node) {
        if (node.nodeValue && CITATION_TEST_RE.test(node.nodeValue)) {
            textNodes.push(node as Text);
        }
        node = walker.nextNode();
    }
    for (const textNode of textNodes) {
        const parent = textNode.parentElement;
        if (!parent) continue;
        const fragment = document.createDocumentFragment();
        const parts = (textNode.nodeValue || "").split(CITATION_SPLIT_RE);
        for (const part of parts) {
            if (!part) continue;
            const match = part.match(/\[\[(\d+)\]\]|\[(\d+)\]/);
            if (match) {
                const index = match[1] || match[2];
                const chip = createSpan({
                    cls: "nm-citation nm-citation-clickable",
                    text: `[${index}]`,
                    attr: {
                        "data-citation-index": index,
                        "role": "button",
                        "tabindex": "0",
                        "aria-label": `Jump to source ${index}`,
                    },
                });
                fragment.appendChild(chip);
            } else {
                fragment.appendChild(document.createTextNode(part));
            }
        }
        parent.replaceChild(fragment, textNode);
    }
}
