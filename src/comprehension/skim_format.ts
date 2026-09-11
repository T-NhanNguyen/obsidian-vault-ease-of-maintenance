// Dense model-facing skim format (R2.2) — the tool result is a terse line
// report, NOT JSON.stringify(report). JSON stays the on-disk cache + internal
// shape; the model sees one line per note, one line per folder, one header.
//
// Split out of runtime_comprehension.ts, which sits at the 1000-line budget.

import { extractTags, type SkimReport } from "./skim";

/** Collapse whitespace/newlines and strip pipe chars so one note stays one
 * line and the `|` delimiter survives. */
function flattenLine(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\|/g, "/").trim();
}

function formatTags(tags: string[]): string {
  return tags.length > 0 ? `[${tags.join(", ")}]` : "-";
}

function noteLine(note: SkimReport["notes"][number]): string {
  const tags = extractTags(note.frontmatter).map((t) => t.toLowerCase());
  const excerpt = flattenLine(note.excerpt) || "(no body)";
  return `## ${note.path} | ${note.kind} | ${note.wordCount}w | ${formatTags(tags)} | ${excerpt}`;
}

function folderLine(dir: SkimReport["directories"][number]): string {
  const tags = dir.dominantTags.map((d) => d.tag);
  const name = dir.path === "" ? "(root)" : dir.path;
  return `## folder: ${name} | ${dir.fileCount} files | ~${dir.avgWords}w avg | tags ${formatTags(tags)}`;
}

/** The one-line-per-note report the model reads for a skim tool result. */
export function formatSkimReport(report: SkimReport, vaultName: string): string {
  const totalFiles = report.directories.reduce((acc, d) => acc + d.fileCount, 0);
  const header =
    `# ${vaultName} — ${totalFiles} files, ${report.directories.length} folders, ` +
    `~${report.totalWords} words total`;
  return [
    header,
    ...report.notes.map(noteLine),
    ...report.directories.map(folderLine),
  ].join("\n");
}
