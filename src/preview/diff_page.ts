// Diff page renderer — generates HTML for pending change review.
// Ported from src/preview/diff_page.py
// For Path C (all-in-plugin), this produces HTML strings usable in Obsidian views.

export function renderValidationBanner(validation: Record<string, unknown>): string {
  const passed = validation.passed !== false;
  const checks = (validation.checks || {}) as Record<string, string>;

  if (passed) {
    return '<div class="banner banner-pass">All validators passed — review the diff below.</div>';
  }

  const items = Object.entries(checks)
    .filter(([k, v]) => !v.startsWith(k + ": pass"))
    .map(([k, v]) => `<li><strong>${k}</strong>: ${String(v)}</li>`);

  if (items.length === 0) {
    return '<div class="banner banner-pass">All validators passed — review the diff below.</div>';
  }

  return (
    '<div class="banner banner-fail">' +
    '<strong>Validation warnings</strong> — review the diff carefully before accepting:' +
    `<ul>${items.join("")}</ul></div>`
  );
}

export function renderDiffHtml(original: string, cleaned: string): string {
  // Simple side-by-side diff using lines
  const origLines = original.split("\n");
  const cleanLines = cleaned.split("\n");

  let html = '<table class="diff"><tr><th>Original</th><th>Cleaned</th></tr>';

  const maxLen = Math.max(origLines.length, cleanLines.length);
  for (let i = 0; i < maxLen; i++) {
    const origLine = i < origLines.length ? origLines[i] : "";
    const cleanLine = i < cleanLines.length ? cleanLines[i] : "";
    if (origLine === cleanLine) {
      html += `<tr><td>${escapeHtml(origLine)}</td><td>${escapeHtml(cleanLine)}</td></tr>`;
    } else {
      html += `<tr><td class="diff_sub">${escapeHtml(origLine)}</td><td class="diff_add">${escapeHtml(cleanLine)}</td></tr>`;
    }
  }

  html += "</table>";
  return html;
}

export function renderDiffPageFromProposal(
  filePath: string,
  original: string,
  cleaned: string,
  validation: Record<string, unknown>,
  pendingId: string,
): string {
  const banner = renderValidationBanner(validation);
  const diff = renderDiffHtml(original, cleaned);

  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Review: ${escapeHtml(filePath)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; background: #f8f9fa; color: #1a1a2e; padding: 20px; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin-bottom: 12px; }
  .banner { padding: 12px 16px; border-radius: 6px; margin-bottom: 16px; font-size: 0.9rem; }
  .banner-pass { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
  .banner-fail { background: #f8d7da; color: #721c24; border: 1px solid #f5c6cb; }
  .banner-fail ul { margin: 8px 0 0 16px; }
  .compare-panels { display: flex; gap: 12px; margin-bottom: 16px; }
  .compare-panel { flex: 1; border: 1px solid #dee2e6; border-radius: 6px; overflow: hidden; background: #fff; }
  .panel-header { padding: 6px 12px; font-weight: 600; font-size: 0.8rem; background: #f1f3f5; border-bottom: 1px solid #dee2e6; }
  .panel-text { padding: 12px; font-family: monospace; font-size: 0.8rem; line-height: 1.5; white-space: pre-wrap; max-height: 70vh; overflow-y: auto; }
  .actions { display: flex; gap: 12px; }
  .actions button { flex: 1; padding: 12px 24px; font-size: 1rem; font-weight: 600; border: none; border-radius: 6px; cursor: pointer; }
  .accept { background: #28a745; color: #fff; }
  .reject { background: #dc3545; color: #fff; }
  table.diff { width: 100%; border-collapse: collapse; font-family: monospace; font-size: 0.8rem; }
  table.diff td { padding: 2px 8px; vertical-align: top; }
  table.diff th { background: #f1f3f5; padding: 4px 8px; text-align: left; }
  .diff_sub { background: #f8d7da; }
  .diff_add { background: #d4edda; }
</style></head>
<body>
  <h1>Review cleanup &mdash; ${escapeHtml(filePath)}</h1>
  ${banner}
  ${diff}
  <div class="actions">
    <button class="accept" onclick="location.href='/preview/${pendingId}/accept'">Accept</button>
    <button class="reject" onclick="location.href='/preview/${pendingId}/reject'">Reject</button>
  </div>
</body></html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
