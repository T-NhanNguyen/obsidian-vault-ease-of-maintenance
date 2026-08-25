// Chat renderer — a minimal RAG chat UI wired to an in-memory query
// function (Path C: no server POST). Container-agnostic: renders the
// message list + input into any host. Hosts the clarify harness: a
// `clarify` tool call mid-run renders the question as an assistant message,
// re-enables the input in answer mode, and the submitted answer resolves
// the tool call (the interactive pattern sort's run-in-review reuses).

import { MarkdownView, Notice } from "obsidian";
import type { ReviewHost } from "./review-host";
import type { ChatQueryResponse, ChatQueryResult } from "./types";
import type { App } from "obsidian";
import { settings } from "./config";
import type { ClarifyArgs, ClarifyAnswerProvider } from "./agent/tools";
import { writeClarifyProposal } from "./agent/clarify";
import type { ClarifyProposal } from "./agent/clarify";

const CHAT_TITLE = "Chat";
const INPUT_PLACEHOLDER = "Ask about your vault…";
const SOURCES_LABEL = "Sources";
const ANSWER_PLACEHOLDER = "Answer the question above… (Esc to skip)";
const SEND_BUTTON_LABEL = "Ask";
const LOADING_LABEL = "Thinking…";
const WAITING_FOR_ANSWER_LABEL = "Waiting for your answer…";
const QUERY_FAILED_PREFIX = "Query failed: ";
const PROPOSAL_HEADING = "Manifest diff";
const NEW_MANIFEST_LABEL = "(new manifest)";
const ACCEPT_BUTTON_LABEL = "Accept — write manifest";
const REJECT_BUTTON_LABEL = "Reject";

export function renderChatReview(
    host: ReviewHost,
    query: (question: string, ask?: ClarifyAnswerProvider) => Promise<ChatQueryResponse>,
    initialQuestion?: string,
): void {
    const container = host.contentEl;
    container.empty();
    host.setTitle(CHAT_TITLE);
    container.addClass("nm-chat");

    const messages = container.createDiv({ cls: "nm-chat-messages" });
    const inputRow = container.createDiv({ cls: "nm-chat-input-row" });
    const input = inputRow.createEl("input", {
        type: "text",
        placeholder: INPUT_PLACEHOLDER,
        cls: "nm-chat-input",
    });
    const sendBtn = inputRow.createEl("button", {
        text: SEND_BUTTON_LABEL,
        cls: "nm-btn nm-btn-primary",
    });

    // The pending clarify question — while set, submit answers it instead of
    // starting a new query; Escape declines (null → NO_ANSWER marker).
    let pendingResolve: ((value: string | null) => void) | null = null;

    function submit() {
        if (pendingResolve) {
            const answer = input.value.trim();
            if (!answer) return; // empty input stays in answer mode
            input.value = "";
            void appendMessage(messages, "user", answer, host);
            pendingResolve(answer);
            return;
        }
        const question = input.value.trim();
        if (!question) return;
        input.value = "";
        void runQuery(question, messages, sendBtn, input, query, host, askProvider);
    }

    sendBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            submit();
        } else if (event.key === "Escape" && pendingResolve) {
            pendingResolve(null);
        }
    });
    input.focus();

    // The clarify answer provider — the mid-run input-request contract: the
    // question renders as an assistant message and the input re-enables in
    // answer mode; the submitted answer resolves the pending tool call.
    const askProvider: ClarifyAnswerProvider = (args: ClarifyArgs) =>
        new Promise<string | null>((resolve) => {
            void appendQuestionMessage(messages, args, host).then(() => {
                const loadingEl = messages.querySelector<HTMLElement>(".nm-msg-loading");
                if (loadingEl) loadingEl.setText(WAITING_FOR_ANSWER_LABEL);
                input.placeholder = ANSWER_PLACEHOLDER;
                input.disabled = false;
                sendBtn.disabled = false;
                input.focus();
                pendingResolve = (value: string | null) => {
                    pendingResolve = null;
                    input.placeholder = INPUT_PLACEHOLDER;
                    input.disabled = true;
                    sendBtn.disabled = true;
                    resolve(value);
                };
            });
        });

    // Auto-run: a command may hand the pane an initial question (the
    // "Understand vault" command starts the pipeline immediately).
    if (initialQuestion) {
        input.value = initialQuestion;
        window.setTimeout(() => submit(), 0);
    }
}

async function runQuery(
    question: string,
    messages: HTMLElement,
    sendBtn: HTMLButtonElement,
    input: HTMLInputElement,
    query: (question: string, ask?: ClarifyAnswerProvider) => Promise<ChatQueryResponse>,
    host: ReviewHost,
    ask: ClarifyAnswerProvider
): Promise<void> {
    await appendMessage(messages, "user", question, host);
    sendBtn.disabled = true;
    input.disabled = true;
    const loading = messages.createDiv({ cls: "nm-msg nm-msg-assistant nm-msg-loading", text: LOADING_LABEL });

    try {
        const data = await query(question, ask);
        loading.remove();
        const answerEl = await appendMessage(messages, "assistant", data.answer || "", host);
        renderSources(answerEl, data.results || [], host, data.citationMap);
        wireCitationNavigation(answerEl, data.citationMap);
        if (data.clarifyProposal) {
            await renderProposal(messages, data.clarifyProposal, host);
        }
    } catch (error) {
        loading.remove();
        const message = error instanceof Error ? error.message : String(error);
        await appendMessage(messages, "assistant", QUERY_FAILED_PREFIX + message, host);
    } finally {
        sendBtn.disabled = false;
        input.disabled = false;
        input.focus();
    }
}

/** The model's clarify question as a chat message: prompt + rendered
 * context (the question stays self-contained). */
async function appendQuestionMessage(
    messages: HTMLElement,
    args: ClarifyArgs,
    host: ReviewHost
): Promise<void> {
    const bubble = messages.createDiv({ cls: "nm-msg nm-msg-assistant" });
    const card = bubble.createDiv({ cls: "nm-clarify-question" });
    card.createDiv({ cls: "nm-clarify-prompt", text: args.question });
    if (args.context) {
        const ctx = card.createDiv({ cls: "nm-clarify-context nm-markdown" });
        await host.renderMarkdown(args.context, ctx);
    }
    messages.scrollTop = messages.scrollHeight;
}

/** The manifest proposal card: diff + accept/reject. Accept performs the
 * guarded write (the ONLY disk write in the clarify flow). */
async function renderProposal(
    messages: HTMLElement,
    proposal: ClarifyProposal,
    host: ReviewHost
): Promise<void> {
    const bubble = messages.createDiv({ cls: "nm-msg nm-msg-assistant" });
    const box = bubble.createDiv({ cls: "nm-clarify-question" });
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

    const settle = (accepted: boolean): void => {
        acceptBtn.disabled = true;
        rejectBtn.disabled = true;
        const rel = proposal.manifestPath ?? settings.manifest.filename;
        if (!accepted) {
            appendStatus(messages, "Rejected — manifest not modified.");
            return;
        }
        try {
            writeClarifyProposal(settings.vaultPath, rel, proposal);
            appendStatus(messages, `Manifest updated: ${rel}`);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            appendStatus(messages, `Write failed: ${message}`);
        }
    };
    acceptBtn.addEventListener("click", () => settle(true));
    rejectBtn.addEventListener("click", () => settle(false));
    messages.scrollTop = messages.scrollHeight;
}

function appendStatus(messages: HTMLElement, text: string): void {
    messages.createDiv({ cls: "nm-msg nm-msg-assistant nm-clarify-status", text });
    messages.scrollTop = messages.scrollHeight;
}

async function appendMessage(
    messages: HTMLElement,
    role: "user" | "assistant",
    text: string,
    host: ReviewHost
): Promise<HTMLElement> {
    const bubble = messages.createDiv({ cls: `nm-msg nm-msg-${role}` });
    if (role === "user") {
        bubble.createEl("p", { text });
    } else {
        // The agent writes markdown; the host renders it with Obsidian's
        // native pipeline (headings, lists, bold, line breaks, citations).
        const body = bubble.createDiv({ cls: "nm-markdown" });
        await host.renderMarkdown(text, body);
    }
    messages.scrollTop = messages.scrollHeight;
    return bubble;
}

function renderSources(
    answerEl: HTMLElement,
    results: ChatQueryResult[],
    host: ReviewHost,
    citationMap?: Record<number, number>
): void {
    if (!results.length) return;
    const sources = answerEl.createEl("details", { cls: "nm-sources" });
    sources.createEl("summary", {
        cls: "nm-sources-title",
        text: `${SOURCES_LABEL} (${results.length})`,
    });
    results.forEach((result, index) => {
        const source = sources.createDiv({ cls: "nm-source nm-source-clickable" });
        source.setAttr("role", "button");
        source.setAttr("tabindex", "0");
        source.setAttr("data-source-index", String(index));
        const location = result.file_path + (result.heading_path ? ` — ${result.heading_path}` : "");
        source.setAttr("aria-label", `Open ${location} in the main window`);
        source.addEventListener("click", () => void openSourceInMainWindow(host.app, result));
        source.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                void openSourceInMainWindow(host.app, result);
            }
        });

        const meta = source.createDiv({ cls: "nm-source-meta" });
        // Show the tool-assigned citation number when available, falling back
        // to the 1‑based result index for consistency.
        const citationNumber = citationMap
            ? Object.entries(citationMap).find(([, srcIdx]) => srcIdx === index)?.[0]
            : undefined;
        const badgeText = citationNumber !== undefined ? String(citationNumber) : String(index + 1);
        meta.createSpan({ cls: "nm-source-index", text: badgeText });
        meta.createSpan({ cls: "nm-source-file", text: result.file_path || "" });
        if (result.heading_path) {
            meta.createSpan({ cls: "nm-source-heading", text: ` — ${result.heading_path}` });
        }
        meta.createSpan({ cls: "nm-source-score", text: ` (${result.score.toFixed(4)})` });
        if (result.text) {
            source.createDiv({ cls: "nm-source-text", text: result.text });
        }
    });
}

function wireCitationNavigation(answerEl: HTMLElement, citationMap?: Record<number, number>): void {
    const jumpToSource = (target: EventTarget | null): void => {
        const chip = (target as HTMLElement | null)?.closest?.("[data-citation-index]") as HTMLElement | null;
        if (!chip) return;
        const citationNumber = Number(chip.getAttribute("data-citation-index"));
        if (!Number.isFinite(citationNumber)) return;
        // Translate the citation number to a 0‑based result-index via the
        // tool's map; fall back to the citation number itself when no map
        // is available (the tool wasn't used, e.g. old test data).
        const resultIndex = citationMap?.[citationNumber] ?? citationNumber - 1;
        const source = answerEl.querySelector(`[data-source-index="${resultIndex}"]`);
        if (!source) return;
        // The sources section is a collapsed <details> — open it first so the
        // target row exists on screen (a hidden row cannot be scrolled to).
        const details = source.closest("details");
        if (details) details.open = true;
        source.scrollIntoView({ behavior: "smooth", block: "center" });
        source.addClass("nm-source-flash");
        window.setTimeout(() => source.removeClass("nm-source-flash"), 1600);
    };

    answerEl.addEventListener("click", (event) => jumpToSource(event.target));
    answerEl.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if ((event.target as HTMLElement | null)?.closest?.("[data-citation-index]")) {
            event.preventDefault();
            jumpToSource(event.target);
        }
    });
}

async function openSourceInMainWindow(app: App, result: ChatQueryResult): Promise<void> {
    try {
        // openLinkText behaves like a link click: opens in the main window
        // even when triggered from the right-sidebar chat pane.
        await app.workspace.openLinkText(result.file_path, "", false);
        // line_start is a 0-based body line index (chunker); editor lines are
        // also 0-based, so jump straight to the section.
        if (result.line_start !== undefined && result.line_start >= 0) {
            app.workspace.getActiveViewOfType(MarkdownView)
                ?.setEphemeralState({ line: result.line_start });
        }
    } catch {
        new Notice(`Could not open ${result.file_path}`);
    }
}
