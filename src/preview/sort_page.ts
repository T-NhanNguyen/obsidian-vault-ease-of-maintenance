// Sort review page renderer — HTML display for triage results.
// Ported from src/preview/sort_page.py

import { SortResult, SortDecision } from "../agent/runtime";

export function renderSortPage(result: SortResult): string {
  const placed = result.placed.length;
  const flagged = result.flagged.length;
  const nearDups = result.decisions.filter(d => d.action === "near_duplicate").length;
  const total = result.decisions.length;

  const renderDecision = (d: SortDecision, i: number): string => {
    let badge = d.action === "placed"
      ? '<span style="color:#28a745">PLACED</span>'
      : d.action === "near_duplicate"
        ? '<span style="color:#dc3545">NEAR-DUP</span>'
        : '<span style="color:#856404">FLAGGED</span>';

    let body = `<p><strong>${escapeHtml(d.sourcePath)}</strong> → ${escapeHtml(d.destPath || "(none)")}</p>`;
    if (d.reason) body += `<p>Reason: ${escapeHtml(d.reason)}</p>`;
    if (d.score) body += `<p>Score: ${d.score.toFixed(3)}</p>`;
    if (d.sourceContent) body += `<pre style="max-height:100px;overflow:auto;font-size:0.8rem;background:#f8f9fa;padding:8px;border-radius:4px">${escapeHtml(d.sourceContent.slice(0, 300))}</pre>`;
    if (d.destContextBefore || d.destContextAfter) {
      body += `<p><em>Destination context:</em></p>`;
      body += `<pre style="max-height:60px;overflow:auto;font-size:0.75rem;background:#f0f7ff;padding:8px;border-radius:4px">${escapeHtml(d.destContextBefore)}<mark>${escapeHtml(d.sourceContent.slice(0, 100))}</mark>${escapeHtml(d.destContextAfter)}</pre>`;
    }

    return `<div style="background:#fff;border:1px solid #dee2e6;border-radius:8px;padding:12px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        ${badge}
        <span style="color:#888">#${i + 1}</span>
      </div>
      ${body}
    </div>`;
  };

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Sort Review</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f5f6f8; color: #1a1a2e; padding: 20px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 1.3rem; }
  .stats { display: flex; gap: 12px; margin-bottom: 20px; }
  .stat { padding: 8px 14px; border-radius: 6px; font-weight: 600; font-size: 0.85rem; }
  .stat-placed { background: #d4edda; color: #155724; }
  .stat-flagged { background: #fff3cd; color: #856404; }
  .stat-neardup { background: #f8d7da; color: #721c24; }
  .suggestions { background: #f0f7ff; border: 1px solid #b8d4f0; border-radius: 8px; padding: 14px 18px; margin-top: 20px; }
</style></head>
<body>
  <h1>Sort Review</h1>
  <p>${total} decisions in ${result.elapsed.toFixed(0)}s</p>
  <div class="stats">
    <span class="stat stat-placed">${placed} placed</span>
    ${flagged > 0 ? `<span class="stat stat-flagged">${flagged} flagged</span>` : ""}
    ${nearDups > 0 ? `<span class="stat stat-neardup">${nearDups} near-duplicates</span>` : ""}
  </div>
  ${result.decisions.map(renderDecision).join("\n")}
  ${result.suggestions ? `<div class="suggestions"><h3>Suggestions</h3><p>${escapeHtml(result.suggestions)}</p></div>` : ""}
</body></html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
