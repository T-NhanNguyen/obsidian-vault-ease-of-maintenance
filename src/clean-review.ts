// Clean review renderer — fetches the pending change JSON and renders the
// diff the server pre-computed (validation banner + side-by-side diff table),
// plus Accept/Reject actions. Container-agnostic: renders into any host.

import type { PendingEntryPayload, ReviewActionResponse } from "./types";
import type { ServerClient } from "./server-client";
import type { ReviewHost } from "./review-host";

const ACCEPT_BUTTON_LABEL = "Accept — write file";
const REJECT_BUTTON_LABEL = "Reject — keep original";
const ACCEPTED_MESSAGE = "Accepted — file written.";
const REJECTED_MESSAGE = "Rejected — file not modified.";
const EXPIRED_MESSAGE = "Preview expired — please re-run the cleanup.";
const NOT_FOUND_MESSAGE = "Preview not found.";
const FAILED_PREFIX = "Review failed (HTTP ";

export async function renderCleanReview(
    host: ReviewHost,
    client: ServerClient,
    pendingId: string
): Promise<void> {
    const payload = await client.get<PendingEntryPayload>(
        `/preview/${encodeURIComponent(pendingId)}/content`
    );
    const container = host.contentEl;
    container.empty();
    host.setTitle(`Review cleanup — ${payload.file_path}`);

    // The server pre-renders the validation banner + static diff table; both
    // are trusted HTML produced by difflib.HtmlDiff and our own banner code.
    const bannerWrap = container.createDiv({ cls: "nm-banner-wrap" });
    bannerWrap.innerHTML = payload.diff_html;
    // difflib inserts "next change" navigation cells (diff_next) between the
    // two sides. The native review UI has no use for them — strip them so the
    // table renders as 4 columns: linenum | original | linenum | cleaned.
    bannerWrap.querySelectorAll(".diff_next").forEach((el) => el.remove());

    const actions = container.createDiv({ cls: "nm-actions" });
    const acceptBtn = actions.createEl("button", {
        text: ACCEPT_BUTTON_LABEL,
        cls: "nm-btn nm-btn-accept",
    });
    const rejectBtn = actions.createEl("button", {
        text: REJECT_BUTTON_LABEL,
        cls: "nm-btn nm-btn-reject",
    });

    acceptBtn.addEventListener("click", () =>
        void resolveReview(payload.pending_id, "accept", acceptBtn, rejectBtn, container, client)
    );
    rejectBtn.addEventListener("click", () =>
        void resolveReview(payload.pending_id, "reject", acceptBtn, rejectBtn, container, client)
    );
}

async function resolveReview(
    pendingId: string,
    action: "accept" | "reject",
    acceptBtn: HTMLButtonElement,
    rejectBtn: HTMLButtonElement,
    container: HTMLElement,
    client: ServerClient
): Promise<void> {
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;

    const result = await client.postReviewAction(
        `/preview/${encodeURIComponent(pendingId)}/${action}`
    );

    container.empty();
    if (result.ok && result.body) {
        const body = result.body as unknown as ReviewActionResponse;
        container.createDiv({ cls: "nm-resolved" }).createEl("p", {
            text: body.message || (action === "accept" ? ACCEPTED_MESSAGE : REJECTED_MESSAGE),
        });
    } else {
        const fallback =
            result.status === 410
                ? EXPIRED_MESSAGE
                : result.status === 404
                  ? NOT_FOUND_MESSAGE
                  : `${FAILED_PREFIX}${result.status}).`;
        const message =
            (result.body as { message?: string } | null)?.message ?? fallback;
        container.createDiv({ cls: "nm-error" }).createEl("p", { text: message });
    }
}
