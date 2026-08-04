// ReviewHost — the minimal surface a UI container (Modal or ItemView) must
// expose so the shared ReviewCore can render into either one.
// app + component + renderMarkdown let renderers use Obsidian's native
// MarkdownRenderer. Tabbed containers (sidebar) route renderers into
// per-tab panels; the modal is single-pane and returns its own contentEl.

import type { App, Component } from "obsidian";

export type ReviewTabId = "chat" | "pending";

export interface ReviewHost {
    /** Content of the ACTIVE tab panel (the sidebar's getter) or the single pane (modal). */
    readonly contentEl: HTMLElement;
    readonly app: App;
    readonly component: Component;
    renderMarkdown(markdown: string, el: HTMLElement): Promise<void>;
    /** Activate a tab, creating it on first use, and return its panel content. */
    activateTab(id: ReviewTabId): HTMLElement;
    /** Close a tab (the sidebar's x button). No-op for the single-pane modal. */
    closeTab(id: ReviewTabId): void;
    setTitle(title: string): void;
}
