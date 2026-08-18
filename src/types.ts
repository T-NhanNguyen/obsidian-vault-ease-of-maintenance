// Shared payload and spec types for the native review UI.
// Path C: no server — every review spec carries its data in memory.
// The two containers (modal + sidebar) render the same specs through ReviewCore.

import type { ClarifyDialogChannel } from "./agent/clarify";

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
    readonly query: (question: string) => Promise<ChatQueryResponse>;
}

export interface ClarifyReviewSpec {
    readonly kind: "clarify";
    readonly id: string;
    /** Runs the whole dialog: ask questions through the channel, show the
     * proposal diff, and write the manifest only after the user accepts. */
    readonly start: (channel: ClarifyDialogChannel) => Promise<void>;
}

export type ReviewSpec = CleanReviewSpec | SortReviewSpec | ChatReviewSpec | ClarifyReviewSpec;

export function specKey(spec: ReviewSpec): string {
    switch (spec.kind) {
        case "clean":
            return `clean:${spec.id}`;
        case "sort":
            return `sort:${spec.id}`;
        case "clarify":
            return `clarify:${spec.id}`;
        case "chat":
            return "chat";
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
}
