// Clarify review renderer — the isolation-test surface for the portable
// clarification dialog (handoff Part A): one self-contained question at a
// time, then the manifest diff with accept/reject. Container-agnostic like
// the other renderers: renders into any ReviewHost (sidebar pane or modal).

import type { ReviewHost } from "./review-host";
import type { ClarifyReviewSpec } from "./types";
import type { ClarifyDialogChannel, ClarifyProposal, ClarifyQuestion } from "./agent/clarify";

const CLARIFY_TITLE = "Clarify";
const ANSWER_BUTTON_LABEL = "Answer";
const SKIP_BUTTON_LABEL = "Stop asking (rest left uncovered)";
const ACCEPT_BUTTON_LABEL = "Accept — write manifest";
const REJECT_BUTTON_LABEL = "Reject";
const PROPOSAL_HEADING = "Manifest diff";
const NEW_MANIFEST_LABEL = "(new manifest)";
const FAILED_PREFIX = "Clarify failed: ";

export function renderClarifyReview(host: ReviewHost, spec: ClarifyReviewSpec): void {
    const container = host.contentEl;
    container.empty();
    host.setTitle(CLARIFY_TITLE);
    container.addClass("nm-clarify");

    const stream = container.createDiv({ cls: "nm-clarify-stream" });
    const channel: ClarifyDialogChannel = {
        ask: (question) => askQuestion(host, stream, question),
        showProposal: (proposal) => showProposal(stream, proposal),
        notify: (text) => appendStatus(stream, text),
    };

    void spec.start(channel).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        appendStatus(stream, FAILED_PREFIX + message);
    });
}

function askQuestion(
    host: ReviewHost,
    stream: HTMLElement,
    question: ClarifyQuestion,
): Promise<string | null> {
    return new Promise((resolve) => {
        const card = stream.createDiv({ cls: "nm-clarify-question" });
        card.createDiv({ cls: "nm-clarify-prompt", text: question.prompt });
        if (question.context) {
            const ctx = card.createDiv({ cls: "nm-clarify-context nm-markdown" });
            void host.renderMarkdown(question.context, ctx);
        }

        const inputRow = card.createDiv({ cls: "nm-clarify-input-row" });
        const input = inputRow.createEl("input", {
            type: "text",
            cls: "nm-clarify-input",
            placeholder: "e.g. meeting notes, reference material, project archive…",
        });
        const answerBtn = inputRow.createEl("button", {
            cls: "nm-btn nm-btn-primary",
            text: ANSWER_BUTTON_LABEL,
        });
        const skipBtn = inputRow.createEl("button", { cls: "nm-btn", text: SKIP_BUTTON_LABEL });

        const done = (value: string | null): void => {
            answerBtn.disabled = true;
            skipBtn.disabled = true;
            input.disabled = true;
            resolve(value);
        };
        const submit = (): void => {
            const value = input.value.trim();
            if (value) done(value);
        };
        answerBtn.addEventListener("click", submit);
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") submit();
        });
        skipBtn.addEventListener("click", () => done(null));
        input.focus();
    });
}

function showProposal(stream: HTMLElement, proposal: ClarifyProposal): Promise<"accept" | "reject"> {
    return new Promise((resolve) => {
        const box = stream.createDiv({ cls: "nm-box nm-clarify-proposal" });
        box.createEl("h3", { text: PROPOSAL_HEADING });
        const meta = box.createDiv({ cls: "nm-clarify-meta" });
        meta.createSpan({
            cls: "nm-clarify-path",
            text: proposal.manifestPath ?? NEW_MANIFEST_LABEL,
        });
        meta.createSpan({
            cls: "nm-clarify-counts",
            text: `${proposal.answered.length} purpose${proposal.answered.length === 1 ? "" : "s"} added` +
                (proposal.unanswered.length ? `, ${proposal.unanswered.length} skipped` : ""),
        });
        box.createEl("pre", { cls: "nm-clarify-diff", text: proposal.diff });

        const actions = box.createDiv({ cls: "nm-clarify-actions" });
        const acceptBtn = actions.createEl("button", {
            cls: "nm-btn nm-btn-primary",
            text: ACCEPT_BUTTON_LABEL,
        });
        const rejectBtn = actions.createEl("button", { cls: "nm-btn", text: REJECT_BUTTON_LABEL });
        acceptBtn.addEventListener("click", () => resolve("accept"));
        rejectBtn.addEventListener("click", () => resolve("reject"));
    });
}

function appendStatus(stream: HTMLElement, text: string): void {
    stream.createDiv({ cls: "nm-clarify-status", text });
    stream.scrollTop = stream.scrollHeight;
}
