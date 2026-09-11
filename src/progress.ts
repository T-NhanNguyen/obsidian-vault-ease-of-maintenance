// Shared live-progress helpers for long chat-surface stages.
//
// The indexer emits per-phase messages and the chat router emits a stage
// rollup; both need the same duration math. BuildProgressCallback itself
// stays in types.ts so this module has no imports and cannot form a cycle.

/** Seconds elapsed since a Date.now() timestamp. */
export function elapsedSeconds(startedAt: number): number {
  return (Date.now() - startedAt) / 1000;
}

/** Whole-second label for progress messages ("12s"). */
export function formatSeconds(seconds: number): string {
  return `${seconds.toFixed(0)}s`;
}

/** Phase-2 heartbeat cadence — how often an in-flight LLM call re-reports
 * itself, so a slow call reads as alive instead of looking hung. */
export const HEARTBEAT_INTERVAL_MS = 5_000;

/** Starts a repeating "still working" timer that reports elapsed seconds, and
 * returns the function that stops it. Outside a browser host (the node test
 * environment) it is a no-op, so no test can leave a live timer behind. */
export function startHeartbeat(
  onTick: (seconds: number) => void,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const startedAt = Date.now();
  const timerId = window.setInterval(() => onTick(elapsedSeconds(startedAt)), intervalMs);
  return () => window.clearInterval(timerId);
}
