// Chat renderer — a minimal RAG chat UI wired to an in-memory query
// function (Path C: no server POST). Container-agnostic: renders the
// message list + input into any host.

import { MarkdownView, Notice } from "obsidian";
import type { ReviewHost } from "./review-host";
import type { ChatQueryResponse, ChatQueryResult } from "./types";
import type { App } from "obsidian";

const CHAT_TITLE = "Chat";
const INPUT_PLACEHOLDER = "Ask about your vault…";
const SEND_BUTTON_LABEL = "Ask";
const LOADING_LABEL = "Thinking…";
const QUERY_FAILED_PREFIX = "Query failed: ";

export function renderChatReview(
    host: ReviewHost,
    query: (question: string) => Promise<ChatQueryResponse>
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

    sendBtn.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
    });
    input.focus();

    function submit() {
        const question = input.value.trim();
        if (!question) return;
        input.value = "";
        void runQuery(question, messages, sendBtn, input, query, host);
    }
}

async function runQuery(
    question: string,
    messages: HTMLElement,
    sendBtn: HTMLButtonElement,
    input: HTMLInputElement,
    query: (question: string) => Promise<ChatQueryResponse>,
    host: ReviewHost
): Promise<void> {
    await appendMessage(messages, "user", question, host);
    sendBtn.disabled = true;
    input.disabled = true;
    const loading = messages.createDiv({ cls: "nm-msg nm-msg-assistant nm-msg-loading", text: LOADING_LABEL });

    try {
        const data = await query(question);
        loading.remove();
        const answerEl = await appendMessage(messages, "assistant", data.answer || "", host);
        renderSources(answerEl, data.results || [], host, data.citationMap);
        wireCitationNavigation(answerEl, data.citationMap);
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
    const sources = answerEl.createDiv({ cls: "nm-sources" });
    sources.createDiv({ cls: "nm-sources-title", text: "Sources" });
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
