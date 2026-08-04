// Chat renderer — a minimal RAG chat UI wired to POST /chat/query.
// Container-agnostic: renders the message list + input into any host.

import type { ReviewHost } from "./review-host";
import type { ServerClient } from "./server-client";
import type { ChatQueryResponse, ChatQueryResult } from "./types";

const CHAT_TITLE = "Chat";
const INPUT_PLACEHOLDER = "Ask about your vault…";
const SEND_BUTTON_LABEL = "Ask";
const LOADING_LABEL = "Thinking…";
const QUERY_FAILED_PREFIX = "Query failed: ";

export function renderChatReview(
    host: ReviewHost,
    client: ServerClient
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
        void runQuery(question, messages, sendBtn, input, client, host);
    }
}

async function runQuery(
    question: string,
    messages: HTMLElement,
    sendBtn: HTMLButtonElement,
    input: HTMLInputElement,
    client: ServerClient,
    host: ReviewHost
): Promise<void> {
    await appendMessage(messages, "user", question, host);
    sendBtn.disabled = true;
    input.disabled = true;
    const loading = messages.createDiv({ cls: "nm-msg nm-msg-assistant nm-msg-loading", text: LOADING_LABEL });

    try {
        const data = await client.post<ChatQueryResponse>("/chat/query", {
            question,
            top_k: 5,
        });
        loading.remove();
        const answerEl = await appendMessage(messages, "assistant", data.answer || "", host);
        renderSources(answerEl, data.results || []);
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

function renderSources(answerEl: HTMLElement, results: ChatQueryResult[]): void {
    if (!results.length) return;
    const sources = answerEl.createDiv({ cls: "nm-sources" });
    sources.createEl("div", { cls: "nm-sources-title", text: "Sources" });
    for (const result of results) {
        const source = sources.createDiv({ cls: "nm-source" });
        const meta = source.createDiv({ cls: "nm-source-meta" });
        meta.createSpan({ cls: "nm-source-file", text: result.file_path || "" });
        if (result.heading_path) {
            meta.createSpan({ cls: "nm-source-heading", text: ` — ${result.heading_path}` });
        }
        meta.createSpan({ cls: "nm-source-score", text: ` (${result.score.toFixed(4)})` });
        if (result.text) {
            source.createDiv({ cls: "nm-source-text", text: result.text });
        }
    }
}
