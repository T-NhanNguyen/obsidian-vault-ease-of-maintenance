// ReviewModal — the centered-overlay container for the shared ReviewCore.
// This is one of two interchangeable containers (the other is ReviewView in
// the sidebar); both render through ReviewCore, so removing either container
// later is a drop-in change.

import { App, Component, Modal } from "obsidian";
import type { ReviewHost } from "./review-host";
import { ReviewCore } from "./review-core";
import { renderAgentMarkdown } from "./render-markdown";
import { getDefaultClient } from "./server-client";
import type { ReviewSpec } from "./types";

export class ReviewModal extends Modal {
    private core: ReviewCore | null = null;
    // Modal is not a Component in Obsidian's API, so markdown rendering
    // registers its inline components on this dedicated one.
    private renderComponent = new Component();

    constructor(
        app: App,
        private readonly spec: ReviewSpec
    ) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass("nm-review-modal");
        const host: ReviewHost = {
            contentEl: this.contentEl,
            app: this.app,
            component: this.renderComponent,
            renderMarkdown: (markdown, el) =>
                renderAgentMarkdown(this.app, this.renderComponent, markdown, el),
            // The modal is single-pane and transient: every spec renders
            // into the same contentEl, and there is nothing to close.
            activateTab: () => this.contentEl,
            closeTab: () => undefined,
            setTitle: (title) => this.titleEl.setText(title),
        };
        this.core = new ReviewCore(host, getDefaultClient());
        void this.core.open(this.spec);
    }

    onClose(): void {
        this.renderComponent.unload();
        this.core = null;
    }
}

export function openReviewInModal(app: App, spec: ReviewSpec): void {
    new ReviewModal(app, spec).open();
}
