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
        this.activeSpecKey = key;
        this.openedSpec = spec;

        const panel = this.host.activateTab(ReviewCore.tabFor(spec));

        // The chat session is mounted once; re-opening chat only activates
        // its tab so an in-flight answer keeps rendering into it.
        if (spec.kind === "chat" && this.chatRendered) {
            return;
        }

        this.showLoading(panel);
        try {
            if (spec.kind === "clean") {
                await renderCleanReview(this.host, spec);
            } else if (spec.kind === "sort") {
                await renderSortReview(this.host, spec.result);
            } else {
                renderChatReview(this.host, spec.query);
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
            if (this.activeSpecKey === "chat") this.activeSpecKey = null;
        } else if (this.activeSpecKey !== "chat") {
            // Clean/sort share the pending tab; closing it clears the chat
            // tab's clarify Q&A session too (the clarify namespace is closed
            // with the tab that owns the dialog).
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
