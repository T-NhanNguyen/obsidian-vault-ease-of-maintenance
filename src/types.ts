// Shared payload and spec types for the native review UI.
// These mirror the JSON the server exposes: /preview/<id>/content,
// /sort-review/<id>/content, /chat/query, and the accept/reject endpoints.

export interface CleanReviewSpec {
    readonly kind: "clean";
    readonly pendingId: string;
}

export interface SortReviewSpec {
    readonly kind: "sort";
    readonly sortId: string;
}

export interface ChatReviewSpec {
    readonly kind: "chat";
}

export type ReviewSpec = CleanReviewSpec | SortReviewSpec | ChatReviewSpec;

export function specKey(spec: ReviewSpec): string {
    switch (spec.kind) {
        case "clean":
            return `clean:${spec.pendingId}`;
        case "sort":
            return `sort:${spec.sortId}`;
        case "chat":
            return "chat";
    }
}

export interface PendingEntryPayload {
    pending_id: string;
    file_path: string;
    meta: Record<string, unknown>;
    diff_html: string;
    original: string;
    cleaned: string;
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
}

export interface ReviewActionResponse {
    status: "accepted" | "rejected" | "expired" | "error";
    message: string;
    freshness_warning?: boolean;
}
