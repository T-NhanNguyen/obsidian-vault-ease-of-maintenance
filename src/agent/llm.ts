// LLM client — multi-turn chat loop with tool/function calling.
// Ported from src/agent/llm.py

import { settings, resolveApiKey } from "../config";
import { getLlmClient, detectProvider, type ILlmClient } from "./llm_client";

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export interface ToolFn {
  (...args: any[]): string;
}

export class Tool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  fn: ToolFn;

  constructor(
    name: string,
    description: string,
    parameters: Record<string, any>,
    fn: ToolFn,
  ) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.fn = fn;
  }

  toOpenAiTool(): Record<string, any> {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }

  call(...args: any[]): string {
    try {
      const result = this.fn(...args);
      return result != null ? String(result) : "(empty)";
    } catch (e: any) {
      return `Error: ${e.message}`;
    }
  }
}

// ---------------------------------------------------------------------------
// LLMClient
// ---------------------------------------------------------------------------

export class LLMClient {
  private model: string;
  private llm: ILlmClient;

  constructor(model?: string) {
    this.model = model || settings.agent.model;
    const apiKey = resolveApiKey();
    const baseUrl = settings.api.baseUrl;
    const provider = detectProvider(baseUrl || "");
    this.llm = getLlmClient(provider, this.model, apiKey, baseUrl);
  }

  async chat(
    system: string,
    user: string,
    tools: Tool[] | null = null,
    maxTurns: number = 10,
  ): Promise<[string, Array<Record<string, any>>]> {
    const messages: Array<Record<string, any>> = [
      { role: "system", content: system },
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
          let fnArgs: Record<string, any> = {};
          try {
            fnArgs = JSON.parse(tc.function.arguments || "{}");
          } catch {
            fnArgs = {};
          }

          const matched = (tools || []).filter(t => t.name === fnName);
          const result = matched.length > 0 ? matched[0].call(fnArgs) : `Unknown tool: ${fnName}`;

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
