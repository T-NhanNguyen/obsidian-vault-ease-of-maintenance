// ReviewCore — the shared renderer used by both UI containers (Modal and
// sidebar ItemView). It owns the loading/error lifecycle, the tab routing
// (chat has its own tab; clean and sort share the pending tab), and the
// render-once rule for the chat session so an in-flight answer survives a
// tab switch.

import type { ReviewHost, ReviewTabId } from "./review-host";
import type { ServerClient } from "./server-client";
import { getDefaultClient } from "./server-client";
import type { ReviewSpec } from "./types";
import { specKey } from "./types";
import { renderCleanReview } from "./clean-review";
import { renderSortReview } from "./sort-review";
import { renderChatReview } from "./chat-review";

const LOADING_LABEL = "Loading review…";

export class ReviewCore {
    private readonly host: ReviewHost;
    private readonly client: ServerClient;
    private openedSpec: ReviewSpec | null = null;
    private activeSpecKey: string | null = null;
    private chatRendered = false;

    constructor(host: ReviewHost, client?: ServerClient) {
        this.host = host;
        this.client = client ?? getDefaultClient();
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
                await renderCleanReview(this.host, this.client, spec.pendingId);
            } else if (spec.kind === "sort") {
                await renderSortReview(this.host, this.client, spec.sortId);
            } else {
                renderChatReview(this.host, this.client);
                this.chatRendered = true;
            }
        } catch (error) {
            this.showError(error, panel);
        }
    }

    /** Forget the tab's spec when it is closed, so the next open re-renders. */
    invalidateTab(tabId: ReviewTabId): void {
        if (tabId === "chat") {
            this.chatRendered = false;
            if (this.activeSpecKey === "chat") this.activeSpecKey = null;
        } else if (this.activeSpecKey !== "chat") {
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
