// Build-side completion handling — shared by the extraction and report loops.
//
// A provider that hits the output cap answers with finish_reason "length" and
// cuts the text mid-line. A partial "ENTITY|Bloom Ener" line would otherwise
// parse as a real entity, so the incomplete final line is dropped before the
// parse. Both legs need this, so it lives in one place.

/** The finish reason a provider returns when the output cap cut the response. */
export const TRUNCATED_FINISH_REASON = "length";

/** True when the output cap cut the response, so its final line is partial. */
export function isOutputTruncated(finishReason?: string): boolean {
  return finishReason === TRUNCATED_FINISH_REASON;
}

/** Drops the final line of a truncated completion. The remaining text holds
 * only complete lines, so the parser never sees a half-written name. */
export function dropIncompleteFinalLine(text: string): string {
  const lastBreak = text.lastIndexOf("\n");
  return lastBreak === -1 ? "" : text.slice(0, lastBreak);
}
