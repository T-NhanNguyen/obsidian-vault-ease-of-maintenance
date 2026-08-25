// ReviewCore — the shared renderer used by both UI containers (Modal and
// sidebar ItemView). It owns the loading/error lifecycle, the tab routing
// (chat has its own tab; clean and sort share the pending tab), and the
// render-once rule for the chat session so an in-flight answer survives a
// tab switch.
//
// Path C: every spec carries its data in memory (no server round trip), so
// the core simply dispatches to the per-kind renderers.

import type { ReviewHost, ReviewTabId } from "./review-host";
import type { ReviewSpec } from "./types";
import { specKey } from "./types";
import { renderCleanReview } from "./clean-review";
import { renderSortReview } from "./sort-review";
import { renderChatReview } from "./chat-review";
import { closeChatSession, closeClarifySession } from "./agent/chat_session";

const LOADING_LABEL = "Loading review…";

export class ReviewCore {
    private readonly host: ReviewHost;
    private openedSpec: ReviewSpec | null = null;
    private activeSpecKey: string | null = null;
    private chatRendered = false;

    constructor(host: ReviewHost) {
        this.host = host;
    }

    get currentSpec(): ReviewSpec | null {
        return this.openedSpec;
    }

    /** Which tab a spec renders into. Chat is unique; clean and sort share pending. */
    private static tabFor(spec: ReviewSpec): ReviewTabId {
        return spec.kind === "chat" ? "chat" : "pending";
    }

    async open(spec: ReviewSpec): Promise<void> {
        const key = specKey(spec);
        if (key === this.activeSpecKey) return; // already open — just activate
        const previousKey = this.activeSpecKey;
        this.activeSpecKey = key;
        this.openedSpec = spec;

        const panel = this.host.activateTab(ReviewCore.tabFor(spec));

        // The chat tab is mounted once per intent: re-opening the same
        // intent (key dedupe above) or returning from another tab only
        // activates it, so an in-flight answer keeps rendering into the
        // hidden tab. Opening a DIFFERENT chat intent (plain chat vs the
        // understand-vault command) re-renders so the new command's query
        // function and auto-submit take effect.
        const chat = spec.kind === "chat";
        if (chat && this.chatRendered) {
            if (!previousKey.startsWith("chat")) return; // returning to mounted chat
            this.chatRendered = false; // different chat intent — re-render
        }

        this.showLoading(panel);
        try {
            if (spec.kind === "clean") {
                await renderCleanReview(this.host, spec);
            } else if (spec.kind === "sort") {
                await renderSortReview(this.host, spec.result);
            } else {
                renderChatReview(this.host, spec.query, spec.initialQuestion);
                this.chatRendered = true;
            }
        } catch (error) {
            this.showError(error, panel);
        }
    }

    /** Forget the tab's spec when it is closed, so the next open re-renders. */
    invalidateTab(tabId: ReviewTabId): void {
        if (tabId === "chat") {
            // The chat session is per-tab: closing the tab clears its memory
            // (file deleted). Reopening starts a fresh session.
            closeChatSession();
            this.chatRendered = false;
            // Any chat-* key (plain chat, understand-vault, build) belongs
            // to the closed tab — forget it so the next open re-renders.
            if (this.activeSpecKey?.startsWith("chat")) this.activeSpecKey = null;
        } else if (!this.activeSpecKey?.startsWith("chat")) {
            // Clean/sort share the pending tab; closing it clears the chat
            // tab's clarify Q&A session too (the clarify namespace is closed
            // with the tab that owns the dialog). A chat spec belongs to the
            // chat tab and survives a pending-tab close.
            closeClarifySession();
            this.activeSpecKey = null;
        }
    }

    private showLoading(panel: HTMLElement): void {
        panel.empty();
        panel.createDiv({ cls: "nm-status", text: LOADING_LABEL });
    }

    private showError(error: unknown, panel: HTMLElement): void {
        panel.empty();
        const message = error instanceof Error ? error.message : String(error);
        panel.createDiv({ cls: "nm-error" }).createEl("p", { text: message });
    }
}
