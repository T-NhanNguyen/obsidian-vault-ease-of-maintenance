import type { ChatMessage } from "./llm_client";
// Chat context assembly.
//
// Numbers the retrieved sources ([1], [2], …) directly in the context so the
// agent can cite them unambiguously and the UI can match every citation to
// the numbered source list. Pure function — unit tested.

import type { ChatQueryResult } from "../types";

export function buildChatContext(results: ChatQueryResult[]): string {
  const blocks = results.map((result, index) => {
    const location =
      result.file_path + (result.heading_path ? ` — ${result.heading_path}` : "");
    return `[${index + 1}] ${location} (lines ${result.line_start}-${result.line_end}):\n${result.text}`;
  });
  return blocks.join("\n\n");
}

// After a tool-calling chat loop the answer may be split across several
// assistant messages (partial text, tool call, continuation).  This joins
// every assistant content fragment into the full answer.
export function reconstructAnswer(history: ChatMessage[]): string {
  const parts: string[] = [];
  for (const msg of history) {
    if (msg.role === "assistant" && msg.content) {
      parts.push(String(msg.content));
    }
  }
  return parts.join("") || "[The agent produced no answer text.]";
}
