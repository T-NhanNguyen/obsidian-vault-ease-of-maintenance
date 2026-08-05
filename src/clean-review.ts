// Clean review renderer — Path C version. Renders a git-style side-by-side
// diff (built client-side with an LCS line diff, themed via CSS variables),
// a validation banner, and Accept/Reject actions. The actual file write on
// accept is delegated to the spec's onResolve callback (provided by the
// plugin), keeping this renderer container-agnostic and testable.
//
// The CSS contract mirrors the original difflib output: table.diff with
// thead th.diff_header, tbody td.diff_header, and diff_add/diff_sub cells,
// all styled in styles.css with Obsidian theme variables.

import type { CleanReviewSpec } from "./types";
import type { ReviewHost } from "./review-host";

const ACCEPT_BUTTON_LABEL = "Accept — write file";
const REJECT_BUTTON_LABEL = "Reject — keep original";
const PASS_BANNER_TEXT = "All validators passed — review the diff below.";
const FAIL_BANNER_TEXT = "Validation warnings — review the diff carefully before accepting:";
const MAX_LCS_CELLS = 2_000_000; // above this, render without diff highlighting

export async function renderCleanReview(
    host: ReviewHost,
    spec: CleanReviewSpec
): Promise<void> {
    const container = host.contentEl;
    container.empty();
    host.setTitle(`Review cleanup — ${spec.proposal.filePath}`);

    // Banner + diff table share one wrap: styles.css scopes the diff table
    // styles to .nm-banner-wrap table.diff.
    const wrap = container.createDiv({ cls: "nm-banner-wrap" });
    renderValidationBanner(wrap, spec.proposal.validation);
    renderSideBySideDiff(wrap, spec.proposal.original, spec.proposal.cleaned);

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
        void resolveReview(spec, "accept", acceptBtn, rejectBtn, container)
    );
    rejectBtn.addEventListener("click", () =>
        void resolveReview(spec, "reject", acceptBtn, rejectBtn, container)
    );
}

async function resolveReview(
    spec: CleanReviewSpec,
    action: "accept" | "reject",
    acceptBtn: HTMLButtonElement,
    rejectBtn: HTMLButtonElement,
    container: HTMLElement
): Promise<void> {
    acceptBtn.disabled = true;
    rejectBtn.disabled = true;

    try {
        const result = await spec.onResolve(action);
        container.empty();
        const box = container.createDiv({ cls: result.ok ? "nm-resolved" : "nm-error" });
        box.createEl("p", { text: result.message });
    } catch (error) {
        container.empty();
        const message = error instanceof Error ? error.message : String(error);
        container.createDiv({ cls: "nm-error" }).createEl("p", { text: message });
    }
}

// ---------------------------------------------------------------------------
// Validation banner
// ---------------------------------------------------------------------------

function renderValidationBanner(
    container: HTMLElement,
    validation: { passed: boolean; checks: Record<string, string> }
): void {
    const wrap = container.createDiv({ cls: "nm-banner-wrap" });
    const banner = wrap.createDiv({
        cls: validation.passed ? "banner banner-pass" : "banner banner-fail",
    });

    if (validation.passed) {
        banner.setText(PASS_BANNER_TEXT);
        return;
    }

    const failures = Object.entries(validation.checks).filter(
        ([key, value]) => !value.startsWith(key + ": pass")
    );
    if (failures.length === 0) {
        banner.setText(PASS_BANNER_TEXT);
        return;
    }

    banner.setText(FAIL_BANNER_TEXT);
    const list = banner.createEl("ul");
    for (const [key, value] of failures) {
        list.createEl("li", { text: `${key}: ${value}` });
    }
}

// ---------------------------------------------------------------------------
// Git-style side-by-side diff (LCS line diff, DOM-built, theme-styled)
// ---------------------------------------------------------------------------

type DiffRow =
    | { kind: "equal"; left: number; right: number }
    | { kind: "delete"; left: number }
    | { kind: "insert"; right: number };

function computeDiffRows(
    original: string[],
    cleaned: string[]
): DiffRow[] | null {
    const m = original.length;
    const n = cleaned.length;
    if (m * n > MAX_LCS_CELLS) return null; // fall back to a plain render

    // LCS table (bottom-up)
    const dp: Uint32Array[] = [];
    for (let i = 0; i <= m; i++) dp.push(new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] =
                original[i] === cleaned[j]
                    ? dp[i + 1][j + 1] + 1
                    : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }

    // Walk the table to emit rows
    const rows: DiffRow[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
        if (original[i] === cleaned[j]) {
            rows.push({ kind: "equal", left: i, right: j });
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            rows.push({ kind: "delete", left: i });
            i++;
        } else {
            rows.push({ kind: "insert", right: j });
            j++;
        }
    }
    while (i < m) {
        rows.push({ kind: "delete", left: i });
        i++;
    }
    while (j < n) {
        rows.push({ kind: "insert", right: j });
        j++;
    }
    return rows;
}

function renderSideBySideDiff(
    container: HTMLElement,
    originalText: string,
    cleanedText: string
): void {
    const original = originalText.split("\n");
    const cleaned = cleanedText.split("\n");

    const table = container.createEl("table", { cls: "diff" });
    const head = table.createEl("thead");
    const headRow = head.createEl("tr");
    headRow.createEl("th", { cls: "diff_header", attr: { colspan: "2" }, text: "Original" });
    headRow.createEl("th", { cls: "diff_header", attr: { colspan: "2" }, text: "Cleaned" });
    const body = table.createEl("tbody");

    const rows = computeDiffRows(original, cleaned);
    if (!rows) {
        // Too large for LCS — render both sides unhighlighted.
        const max = Math.max(original.length, cleaned.length);
        for (let k = 0; k < max; k++) {
            appendRow(body, k < original.length ? k + 1 : 0, original[k] ?? "", k < cleaned.length ? k + 1 : 0, cleaned[k] ?? "");
        }
        return;
    }

    for (const row of rows) {
        if (row.kind === "equal") {
            appendRow(body, row.left + 1, original[row.left], row.right + 1, cleaned[row.right]);
        } else if (row.kind === "delete") {
            appendRow(body, row.left + 1, original[row.left], 0, "", "diff_sub");
        } else {
            appendRow(body, 0, "", row.right + 1, cleaned[row.right], "diff_add");
        }
    }
}

function appendRow(
    body: HTMLElement,
    leftNo: number,
    leftText: string,
    rightNo: number,
    rightText: string,
    textClass = ""
): void {
    const tr = body.createEl("tr");
    tr.createEl("td", { cls: "diff_header", text: leftNo ? String(leftNo) : "" });
    const leftCell = tr.createEl("td", { cls: textClass });
    leftCell.setText(leftText);
    tr.createEl("td", { cls: "diff_header", text: rightNo ? String(rightNo) : "" });
    const rightCell = tr.createEl("td", { cls: textClass });
    rightCell.setText(rightText);
}
