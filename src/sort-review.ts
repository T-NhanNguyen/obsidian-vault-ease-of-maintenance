// Sort review renderer — renders stats badges and one card per triage
// decision from an in-memory SortResultPayload (Path C: no server fetch).
// Built with Obsidian-native DOM (textContent escaping, theme variables).

import type { ReviewHost } from "./review-host";
import type { SortDecisionPayload, SortResultPayload } from "./types";

const SORT_REVIEW_TITLE = "Sort Review";

const ACTION_BADGE_CLASS: Record<string, string> = {
    placed: "nm-badge-placed",
    flagged: "nm-badge-flagged",
    near_duplicate: "nm-badge-near-dup",
    no_destination: "nm-badge-no-dest",
};

export async function renderSortReview(
    host: ReviewHost,
    payload: SortResultPayload
): Promise<void> {
    const container = host.contentEl;
    container.empty();
    host.setTitle(SORT_REVIEW_TITLE);

    const decisions = payload.decisions ?? [];
    const placedCount = decisions.filter((d) => d.action === "placed").length;
    const flaggedCount = decisions.filter((d) => d.action === "flagged").length;
    const nearDuplicateCount = decisions.filter(
        (d) => d.action === "near_duplicate"
    ).length;
    const totalCount = decisions.length;

    const stats = container.createDiv({ cls: "nm-stats" });
    createStatBadge(stats, "nm-stat-placed", `${placedCount} placed`);
    if (flaggedCount) createStatBadge(stats, "nm-stat-flagged", `${flaggedCount} flagged`);
    if (nearDuplicateCount) createStatBadge(stats, "nm-stat-near-dup", `${nearDuplicateCount} near-duplicates`);
    createStatBadge(stats, "nm-stat-total", `${totalCount} total`);

    if (payload.elapsed !== undefined) {
        container.createDiv({ cls: "nm-subtitle", text: `Sort completed in ${Math.round(payload.elapsed)}s` });
    }

    for (const decision of decisions) {
        container.appendChild(renderDecisionCard(decision));
    }

    if (payload.suggestions) {
        const box = container.createDiv({ cls: "nm-box nm-suggestions" });
        box.createEl("h3", { text: "Suggestions" });
        const body = box.createDiv({ cls: "nm-markdown" });
        await host.renderMarkdown(payload.suggestions, body);
    }

    if (payload.manifest_constitution) {
        const box = container.createDiv({ cls: "nm-box nm-manifest" });
        box.createEl("h3", { text: "Manifest constitution" });
        box.createEl("pre", { text: payload.manifest_constitution });
    }
}

function createStatBadge(parent: HTMLElement, cls: string, label: string): void {
    parent.createDiv({ cls: `nm-stat ${cls}`, text: label });
}

function renderDecisionCard(decision: SortDecisionPayload): HTMLElement {
    const card = createDiv({ cls: "nm-card" });

    const header = card.createDiv({ cls: "nm-card-header" });
    header.createSpan({
        cls: `nm-badge ${ACTION_BADGE_CLASS[decision.action] ?? "nm-badge-flagged"}`,
        text: decision.action,
    });
    header.createSpan({ cls: "nm-card-path", text: decision.source_path });
    if (decision.score) {
        header.createSpan({ cls: "nm-card-score", text: `score=${decision.score.toFixed(2)}` });
    }

    const body = card.createDiv({ cls: "nm-card-body" });
    if (decision.action === "placed") {
        body.appendChild(renderPlacedPanels(decision));
    } else if (decision.action === "near_duplicate") {
        body.appendChild(
            renderSinglePanel(decision, `near-duplicate of ${decision.dest_path || "?"}`, "nm-panel-label-source")
        );
    } else {
        body.appendChild(
            renderSinglePanel(decision, decision.reason || "flag", "nm-panel-label-source")
        );
    }

    if (decision.dest_path && decision.dest_heading) {
        card.createDiv({
            cls: "nm-card-footer",
            text: `Destination: ${decision.dest_path} → ${decision.dest_heading}`,
        });
    }

    return card;
}

function renderPlacedPanels(decision: SortDecisionPayload): HTMLElement {
    const panels = createDiv({ cls: "nm-panels" });

    const sourcePanel = createDiv({ cls: "nm-panel nm-panel-source" });
    sourcePanel.createDiv({ cls: "nm-panel-label nm-panel-label-source", text: "✕ inbox (removed)" });
    const sourceContent = sourcePanel.createDiv({ cls: "nm-panel-content nm-strikethrough" });
    sourceContent.setText(decision.source_content);

    const destPanel = createDiv({ cls: "nm-panel nm-panel-dest" });
    if (decision.dest_path) {
        destPanel.createDiv({
            cls: "nm-panel-label nm-panel-label-dest",
            text: `→ ${decision.dest_path}`,
        });
    }
    const destContent = destPanel.createDiv({ cls: "nm-panel-content" });
    if (decision.dest_context_before) {
        destContent.appendText(decision.dest_context_before + "\n");
    }
    destContent.createSpan({ cls: "nm-highlight", text: decision.source_content });
    if (decision.dest_context_after) {
        destContent.appendText("\n" + decision.dest_context_after);
    }

    panels.appendChild(sourcePanel);
    panels.appendChild(destPanel);
    return panels;
}

function renderSinglePanel(
    decision: SortDecisionPayload,
    label: string,
    labelCls: string
): HTMLElement {
    const panel = createDiv({ cls: "nm-panel" });
    panel.createDiv({ cls: `nm-panel-label ${labelCls}`, text: label });
    panel.createDiv({ cls: "nm-panel-content nm-flagged-content", text: decision.source_content });
    return panel;
}
