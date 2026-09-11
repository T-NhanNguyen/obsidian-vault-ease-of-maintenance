// Temporary build diagnostics — timestamped lines for every long stage, so a
// stalled phase 2 can be told apart from a merely slow one in the developer
// console (Ctrl/Cmd+Shift+I → Console).
//
// TEMPORARY: flip DEBUG_LOGGING to false — or delete this file and the
// debugLog call sites — once the phase-2 blackout investigation is over.
// Every call is a no-op while the flag is false.

/** Master switch for the temporary build diagnostics. */
export const DEBUG_LOGGING = true;

/** One timestamped diagnostic line: [HH:MM:SS.mmm] [build-debug:<scope>] … */
export function debugLog(scope: string, message: string): void {
  if (!DEBUG_LOGGING) return;
  const stamp = new Date().toISOString().slice(11, 23);
  console.debug(`[${stamp}] [build-debug:${scope}] ${message}`);
}
