// Shared payload and spec types for the native review UI.
// Path C: no server — every review spec carries its data in memory.
// The two containers (modal + sidebar) render the same specs through ReviewCore.

import type { ClarifyProposal } from "./agent/clarify";
import type { ClarifyAnswerProvider } from "./agent/tools";

export interface CleanProposalPayload {
    filePath: string;
    vaultPath: string;
    original: string;
    cleaned: string;
    validation: { passed: boolean; checks: Record<string, string> };
    opsApplied: number;
    opsRejected: number;
}

export interface CleanResolveResult {
    ok: boolean;
    message: string;
}

export interface CleanReviewSpec {
    readonly kind: "clean";
    readonly id: string;
    readonly proposal: CleanProposalPayload;
    /** Performs accept (write cleaned + .bak) or reject (no-op). */
    readonly onResolve: (action: "accept" | "reject") => Promise<CleanResolveResult>;
}

export interface SortReviewSpec {
    readonly kind: "sort";
    readonly id: string;
    readonly result: SortResultPayload;
}

export interface ChatReviewSpec {
    readonly kind: "chat";
    /** The ask parameter is the chat UI's in-flight answer provider (the
     * clarify tool's channel); it is passed per-call so the renderer owns
     * its answer surface. */
    readonly query: (
        question: string,
        ask?: ClarifyAnswerProvider,
    ) => Promise<ChatQueryResponse>;
    /** Optional question to auto-submit once the pane renders (a command
     * like "Understand vault" starts its run immediately). */
    readonly initialQuestion?: string;
}

export type ReviewSpec = CleanReviewSpec | SortReviewSpec | ChatReviewSpec;

export function specKey(spec: ReviewSpec): string {
    switch (spec.kind) {
        case "clean":
            return `clean:${spec.id}`;
        case "sort":
            return `sort:${spec.id}`;
        case "chat":
            // Intent-aware: the plain chat command and the understand-vault
            // command (auto-submitting an initial question) are distinct
            // specs so the review core can switch the pane between them.
            return spec.initialQuestion ? `chat:${spec.initialQuestion}` : "chat";
    }
}

export interface SortDecisionPayload {
    unit_id: string;
    source_handle: string;
    source_path: string;
    source_content: string;
    action: string;
    score: number;
    reason: string;
    dest_path: string;
    dest_heading: string;
    dest_context_before: string;
    dest_context_after: string;
}

export interface SortResultPayload {
    decisions: SortDecisionPayload[];
    manifest_constitution: string;
    suggestions: string;
    elapsed: number;
}

export interface ChatQueryResult {
    node_key: string;
    file_path: string;
    heading_path: string;
    score: number;
    text: string;
    line_start: number;
    line_end: number;
}

export interface ChatQueryResponse {
    answer: string;
    results: ChatQueryResult[];
    /** citation-number → 0‑based index into results (from the cite_source tool) */
    citationMap?: Record<number, number>;
    /** Manifest proposal reconciled from the run's clarify Q&A (the chat
     * manifest task) — the renderer shows the diff and the user confirms
     * the write. Absent when the run produced no proposal. */
    clarifyProposal?: ClarifyProposal;
}
