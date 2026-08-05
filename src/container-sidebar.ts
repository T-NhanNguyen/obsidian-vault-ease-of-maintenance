// ReviewView — the docked right-sidebar container for the shared ReviewCore.
// This is one of two interchangeable containers (the other is ReviewModal);
// both render through ReviewCore, so either can be removed without touching
// the rendering logic.
//
// The sidebar is tabbed: "Chat" (unique) and "Pending Review" (shared by
// clean and sort). Tabs stay mounted while inactive, so an in-flight chat
// answer keeps rendering into its hidden tab. Each tab has an x close
// button; closing it unmounts that panel.

import { App, ItemView, Notice, ViewStateResult, WorkspaceLeaf } from "obsidian";
import type { ReviewHost, ReviewTabId } from "./review-host";
import { ReviewCore } from "./review-core";
import { renderAgentMarkdown } from "./render-markdown";
import type { ReviewSpec } from "./types";

export const REVIEW_VIEW_TYPE = "note-maintainer-review";

const TAB_LABELS: Record<ReviewTabId, string> = {
    chat: "Chat",
    pending: "Pending Review",
};

const EMPTY_STATE_TEXT = "No open tabs. Open Chat or run a cleanup or sort.";
const VIEW_NAME = "Vault Ease of Maintenance";

interface ReviewViewState {
    spec?: ReviewSpec;
    [key: string]: unknown;
}

interface TabEntry {
    button: HTMLElement;
    panel: HTMLElement;
}

export class ReviewView extends ItemView {
    private core: ReviewCore | null = null;
    // No spec until a command opens one — tabs must not appear at startup.
    private spec: ReviewSpec | null = null;
    private viewTitle = VIEW_NAME;
    private tabBar: HTMLElement | null = null;
    private panelsEl: HTMLElement | null = null;
    private activePanel: HTMLElement | null = null;
    private readonly tabs = new Map<ReviewTabId, TabEntry>();

    constructor(leaf: WorkspaceLeaf) {
        super(leaf);
    }

    getViewType(): string {
        return REVIEW_VIEW_TYPE;
    }

    getDisplayText(): string {
        return this.viewTitle;
    }

    getIcon(): string {
        return ""; // text-only header: the pane is identified by its name
    }

    getState(): ReviewViewState {
        // Do not persist the open spec — on restart the pane must stay empty
        // until a command opens a review again.
        return {};
    }

    async setState(state: ReviewViewState, result: ViewStateResult): Promise<void> {
        void result;
        if (state?.spec) {
            this.spec = state.spec;
            await this.reopen();
        }
    }

    async setSpec(spec: ReviewSpec): Promise<void> {
        this.spec = spec;
        await this.reopen();
    }

    async onOpen(): Promise<void> {
        const state = this.leaf.getViewState().state as ReviewViewState | undefined;
        if (state?.spec) this.spec = state.spec;
        this.contentEl.addClass("nm-review");
        // setViewState on an existing leaf can re-run onOpen — do not
        // build a second tab bar.
        if (!this.tabBar) this.buildTabChrome();
        await this.reopen();
    }

    async onClose(): Promise<void> {
        this.core = null;
        this.tabs.clear();
        this.activePanel = null;
        this.tabBar = null;
        this.panelsEl = null;
    }

    private async reopen(): Promise<void> {
        if (!this.spec) {
            this.showEmptyState();
            return;
        }
        this.core ??= new ReviewCore(this.makeHost());
        await this.core.open(this.spec);
    }

    private showEmptyState(): void {
        this.panelsEl?.empty();
        this.panelsEl?.createDiv({ cls: "nm-tab-empty", text: EMPTY_STATE_TEXT });
        this.activePanel = null;
    }

    // ------------------------------------------------------------------
    // Tab management
    // ------------------------------------------------------------------

    private buildTabChrome(): void {
        this.tabBar = this.contentEl.createDiv({ cls: "nm-tab-bar" });
        this.panelsEl = this.contentEl.createDiv({ cls: "nm-tab-panels" });
    }

    private activateTab(id: ReviewTabId): HTMLElement {
        // A tab is now open — the "no tabs" empty state must go.
        this.panelsEl?.querySelectorAll(".nm-tab-empty").forEach((el) => el.remove());
        let tab = this.tabs.get(id);
        if (!tab) {
            tab = this.createTab(id);
            this.tabs.set(id, tab);
        }
        this.tabs.forEach((entry, tabId) => {
            const active = tabId === id;
            entry.button.toggleClass("nm-tab-active", active);
            entry.panel.toggleClass("nm-tab-active", active);
            entry.panel.style.display = active ? "" : "none";
        });
        this.activePanel = tab.panel;
        return tab.panel;
    }

    private createTab(id: ReviewTabId): TabEntry {
        const button = this.tabBar!.createDiv({ cls: "nm-tab" });
        button.createSpan({ text: TAB_LABELS[id] });
        const closeBtn = button.createEl("button", {
            cls: "nm-tab-close",
            text: "×",
            attr: { "aria-label": `Close ${TAB_LABELS[id]} tab` },
        });
        closeBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            this.closeTab(id);
        });
        button.addEventListener("click", () => this.activateTab(id));

        const panel = this.panelsEl!.createDiv({ cls: "nm-tab-panel" });
        return { button, panel };
    }

    private closeTab(id: ReviewTabId): void {
        const tab = this.tabs.get(id);
        if (!tab) return;
        tab.button.remove();
        tab.panel.remove();
        this.tabs.delete(id);
        this.core?.invalidateTab(id);

        if (this.activePanel === tab.panel) {
            this.activePanel = null;
            const remaining = [...this.tabs.keys()];
            if (remaining.length > 0) {
                this.activateTab(remaining[0]);
            } else {
                this.panelsEl?.empty();
                this.panelsEl?.createDiv({ cls: "nm-tab-empty", text: EMPTY_STATE_TEXT });
            }
        }
    }

    // ------------------------------------------------------------------
    // Host
    // ------------------------------------------------------------------

    private makeHost(): ReviewHost {
        const view = this;
        return {
            // Renderers target the ACTIVE tab panel, not the view container.
            get contentEl(): HTMLElement {
                return view.activePanel ?? view.panelsEl ?? document.createElement("div");
            },
            app: view.app,
            component: view,
            renderMarkdown: (markdown, el) =>
                renderAgentMarkdown(view.app, view, markdown, el),
            activateTab: (id) => view.activateTab(id),
            closeTab: (id) => view.closeTab(id),
            setTitle: () => undefined, // the pane header keeps the static project name
        };
    }
}

export async function openReviewInSidebar(app: App, spec: ReviewSpec): Promise<void> {
    const existing = app.workspace.getLeavesOfType(REVIEW_VIEW_TYPE)[0];
    // Reuse an existing review pane; otherwise create a dedicated right-sidebar
    // leaf instead of hijacking whatever the user already has open there.
    const leaf = existing ?? app.workspace.getRightLeaf(true);
    if (!leaf) {
        new Notice("Could not open a review pane.");
        return;
    }
    await leaf.setViewState({ type: REVIEW_VIEW_TYPE, active: true, state: { spec } });
    app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof ReviewView) {
        await view.setSpec(spec);
    }
}
