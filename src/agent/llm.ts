// LLM client — multi-turn chat loop with tool/function calling.
// Ported from src/agent/llm.py

import { settings, resolveApiKey, reasoningConfig, type ReasoningSettings } from "../config";
import { errorMessage } from "../errors";
import { getLlmClient, detectProvider, type ILlmClient, type ChatMessage, type ChatTool } from "./llm_client";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

// Tool fns receive the parsed JSON args object as their single argument
// (the Python original bound **kwargs to named params; TS has no kwargs,
// so the fn contract is the args object itself). Implementations cast to
// their declared shape at the top (see ApplyEditsArgs in tools.ts).
// Async fns are supported — retrieval tools (search_index) must await an
// embeddings HTTP round trip before returning.
export type ToolFn = (args: Record<string, unknown>) => string | Promise<string>;

export class Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  fn: ToolFn;

  constructor(
    name: string,
    description: string,
    parameters: Record<string, unknown>,
    fn: ToolFn,
  ) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.fn = fn;
  }

  toOpenAiTool(): ChatTool {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }

  async call(args: Record<string, unknown>): Promise<string> {
    try {
      const result = await this.fn(args);
      return result != null ? String(result) : "(empty)";
    } catch (e) {
      return `Error: ${errorMessage(e)}`;
    }
  }
}

// ---------------------------------------------------------------------------
// LLMClient
// ---------------------------------------------------------------------------

export class LLMClient {
  private model: string;
  private llm: ILlmClient;

  // The optional llm param is a test seam only: a fake ILlmClient drives the
  // real chat() loop without HTTP. The ?? fallback keeps the default branch
  // byte-for-byte identical to the pre-seam behavior; the seam never grows
  // into a config surface.
  //
  // Reasoning comes from the ONE global setting (Settings tab dropdowns /
  // config.yaml `reasoning:`), so every feature and every provider share it.
  // Passing `reasoning: null` means "send no reasoning params at all" — the
  // capability probe uses that so its tool-call detection is never degraded
  // by a disabled-thinking payload.
  constructor(model?: string, llm?: ILlmClient, options?: { reasoning?: ReasoningSettings | null }) {
    this.model = model || settings.agent.model;
    const reasoning = options?.reasoning === undefined ? reasoningConfig() : options.reasoning;
    this.llm = llm ?? getLlmClient(
      detectProvider(settings.api.baseUrl || ""),
      this.model,
      resolveApiKey(),
      settings.api.baseUrl,
      reasoning,
    );
  }

  async chat(
    system: string,
    user: string,
    tools: Tool[] | null = null,
    maxTurns: number = 10,
    history: ChatMessage[] = [],
  ): Promise<[string, ChatMessage[]]> {
    // Prior conversation turns (persistent chat session) are injected between
    // the system prompt and the current user message — the model sees proper
    // user/assistant roles instead of flattened text. See chat_session.ts.
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history,
      { role: "user", content: user },
    ];

    for (let turn = 0; turn < maxTurns; turn++) {
      const openaiTools = tools ? tools.map(t => t.toOpenAiTool()) : null;
      const response = await this.llm.chatCompletion(this.model, messages, openaiTools);

      const toolCalls = response.toolCalls;

      if (toolCalls && toolCalls.length > 0) {
        // Add assistant message with tool calls (keep any partial text — the
        // model may emit content alongside tool_calls, and the client needs
        // both for answer reconstruction).
        messages.push({
          role: "assistant",
          content: response.content || null,
          tool_calls: toolCalls.map(tc => ({
            id: tc.id,
            type: "function",
            function: {
              name: tc.function.name,
              arguments: tc.function.arguments,
            },
          })),
        });

        // Execute each tool
        for (const tc of toolCalls) {
          const fnName = tc.function.name;
          let fnArgs: Record<string, unknown> = {};
          try {
            fnArgs = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
          } catch {
            fnArgs = {};
          }

          const matched = (tools || []).filter(t => t.name === fnName);
          const result = matched.length > 0
            ? await matched[0].call(fnArgs)
            : `Unknown tool: ${fnName}`;

          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result,
          });
        }
      } else if (response.content) {
        messages.push({
          role: "assistant",
          content: response.content,
        });
        return [response.content, messages];
      } else {
        return ["", messages];
      }
    }

    return ["", messages];
  }
}
