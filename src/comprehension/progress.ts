// Chat-surface progress lines for the comprehension pass.
//
// Comprehension runs before the index build and can take minutes. Without
// these lines the chat surface shows only "Thinking…" until phase 1 finishes,
// which reads as a hang. The run loop reports every turn and every tool call
// through one transient element the renderer rewrites in place.

/** Turn start: how far the run has come through its turn budget. */
export function comprehensionTurnMessage(
  turn: number,
  maxTurns: number,
  used: number,
  budget: number,
): string {
  return `Comprehension: turn ${turn}/${maxTurns} (${used}/${budget} tool calls).`;
}

/** One finished tool call — the same element is rewritten for the next one. */
export function comprehensionToolMessage(toolName: string, used: number, budget: number): string {
  return `Comprehension: ${toolName} → ${used}/${budget} tool calls.`;
}
