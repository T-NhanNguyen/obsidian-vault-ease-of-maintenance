// apply_edits op core — the pure, deterministic edit pipeline shared by the
// write-to-disk tool (applyEdits) and the preview-only impl (applyEditsImpl).
// Split out of tools.ts so the edit-op concern is adjustable without touching
// the tool schemas / file tools / citation tracking.

export interface OpAnchor {
  start?: number;
  end?: number;
  before_line?: number;
}

export interface EditOp {
  op: string;
  kind?: string;
  anchor?: OpAnchor;
  text?: string;
  reason?: string;
}

export interface ApplyEditsArgs {
  handle: string;
  ops: EditOp[];
}

const VALID_OPS = ["join_lines", "insert_header", "remove_span", "collapse_blanks", "insert_flag"];
const VALID_SPAN_KINDS = ["tag", "properties_block"];

function validateOp(op: EditOp, lines: string[]): string | null {
  const kind = op.op;
  const anchor: OpAnchor = op.anchor || {};
  const maxLine = lines.length;

  if (!VALID_OPS.includes(kind)) {
    return `UNKNOWN_OP: ${kind}`;
  }

  for (const key of ["start", "end", "before_line"] as const) {
    const val = anchor[key];
    if (val !== undefined && (typeof val !== "number" || val < 1 || val > maxLine + 10)) {
      return `INVALID_ANCHOR: ${key}=${val} (max_line=${maxLine})`;
    }
  }

  const s = anchor.start;
  const e = anchor.end;
  if (s !== undefined && e !== undefined && s > e) {
    return `INVALID_RANGE: start=${s} > end=${e}`;
  }

  if (kind === "remove_span") {
    if (!VALID_SPAN_KINDS.includes(op.kind || "")) {
      return `INVALID_KIND: ${op.kind} (expected ${VALID_SPAN_KINDS.join(", ")})`;
    }
  }

  return null;
}

export interface AppliedEdits {
  lines: string[];
  validOps: EditOp[];
  rejected: Array<{ op: string; reason: string }>;
  diffStat: Record<string, number>;
  /** remove_span kinds that may be removed freely (word-conservation). */
  sanctionWords: string[];
}

/**
 * Shared apply pipeline: validate every op against the ORIGINAL lines, then
 * apply the valid ones in order (line offsets shift as lines are edited).
 * Used by both the disk-writing tool and the preview-only impl, so the two
 * can never drift.
 */
export function applyOps(ops: EditOp[], lines: string[]): AppliedEdits {
  const rejected: Array<{ op: string; reason: string }> = [];
  const validOps: EditOp[] = [];

  for (const op of ops) {
    const err = validateOp(op, lines);
    if (err) {
      rejected.push({ op: op.op, reason: err });
    } else {
      validOps.push(op);
    }
  }

  let offset = 0;
  const diffStat: Record<string, number> = {};

  for (const op of validOps) {
    const kind = op.op;
    diffStat[kind] = (diffStat[kind] || 0) + 1;
    const anchor: OpAnchor = op.anchor || {};

    if (kind === "join_lines") {
      const s = Number(anchor.start) - 1 + offset;
      const e = Number(anchor.end) - 1 + offset;
      lines[s] = lines.slice(s, e + 1).map((l: string) => l.trim()).join(" ");
      lines.splice(s + 1, e - s);
      offset -= e - s;
    } else if (kind === "insert_header") {
      const idx = Number(anchor.before_line) - 1 + offset;
      lines.splice(idx, 0, op.text || "");
      offset += 1;
    } else if (kind === "remove_span") {
      const s = Number(anchor.start) - 1 + offset;
      const e = Number(anchor.end) - 1 + offset;
      lines.splice(s, e - s + 1);
      offset -= e - s + 1;
    } else if (kind === "collapse_blanks") {
      const s = Number(anchor.start) - 1 + offset;
      const e = Number(anchor.end) - 1 + offset;
      const blankCount = lines.slice(s, Math.min(e + 1, lines.length))
        .filter((l: string) => !l.trim()).length;
      if (blankCount > 1) {
        let keptOne = false;
        const newLines = lines.slice(0, s);
        for (let i = s; i < Math.min(e + 1, lines.length); i++) {
          if (!lines[i].trim()) {
            if (!keptOne) {
              newLines.push("");
              keptOne = true;
            }
          } else {
            newLines.push(lines[i]);
          }
        }
        if (e + 1 < lines.length) {
          newLines.push(...lines.slice(e + 1));
        }
        lines = newLines;
      }
    } else if (kind === "insert_flag") {
      const idx = Number(anchor.before_line) - 1 + offset;
      const flag = `<!-- review: ${op.reason || "flag"} -->`;
      lines.splice(idx, 0, flag);
      offset += 1;
    }
  }

  const sanctionWords: string[] = [];
  for (const op of ops) {
    if (op.op === "remove_span" && VALID_SPAN_KINDS.includes(op.kind || "")) {
      sanctionWords.push(op.kind || "");
    }
  }

  return { lines, validOps, rejected, diffStat, sanctionWords };
}
