// LLM chat loop tool-dispatch tests — the seam-based happy path from the
// handoff plan. A fake ILlmClient drives the real chat() loop so the glue
// line (matched[0].call(fnArgs)) is covered end-to-end — the exact layer
// where the apply_edits dispatch-shape bug lived.

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import { LLMClient, Tool } from "../../src/agent/llm";
import { APPLY_EDITS_TOOL, applyEdits } from "../../src/agent/tools";
import type {
  ChatResponse,
  ChatMessage,
  ChatTool,
  ILlmClient,
} from "../../src/agent/llm_client";
import { updateSettings, defaultSettings } from "../../src/config";
import { makeToolVault, tmpFilesIn } from "../fixtures/tool_helpers";

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };

class StubLlmClient implements ILlmClient {
  private queue: ChatResponse[];

  constructor(queue: ChatResponse[]) {
    this.queue = [...queue];
  }

  async chatCompletion(
    _model: string,
    _messages: ChatMessage[],
    _tools?: ChatTool[] | null,
  ): Promise<ChatResponse> {
    const next = this.queue.shift();
    if (!next) throw new Error("StubLlmClient: response queue exhausted");
    return next;
  }
}

function stubResponse(overrides: Partial<ChatResponse>): ChatResponse {
  return {
    completionId: "c",
    role: "assistant",
    content: "",
    usage: USAGE,
    ...overrides,
  };
}

afterAll(() => {
  updateSettings(defaultSettings());
});

describe("chat loop tool dispatch (seam-based happy path)", () => {
  it("surfaces the apply_edits receipt in the returned message history", async () => {
    const vault = makeToolVault("# Title\n\nHello world.\n");
    const tool = new Tool(
      APPLY_EDITS_TOOL.name,
      APPLY_EDITS_TOOL.description,
      APPLY_EDITS_TOOL.parameters,
      applyEdits,
    );
    const stub = new StubLlmClient([
      stubResponse({
        completionId: "c1",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "apply_edits",
              arguments: JSON.stringify({
                handle: vault.handle,
                ops: [{ op: "insert_header", anchor: { before_line: 2 }, text: "# New" }],
              }),
            },
          },
        ],
      }),
      stubResponse({ completionId: "c2", content: "Done." }),
    ]);

    const client = new LLMClient("test-model", stub);
    const [answer, history] = await client.chat("system", "user", [tool], 3);

    expect(answer).toBe("Done.");
    const toolMessages = history.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    const receipt = JSON.parse(toolMessages[0].content as string) as { receipt_id: string };
    expect(receipt.receipt_id).toMatch(/^r_\d{4}$/);
    expect(fs.readFileSync(vault.notePath, "utf-8")).toContain("# New");
    expect(tmpFilesIn(vault.vaultDir)).toEqual([]);
  });

  it("reports unknown tool names without crashing", async () => {
    const vault = makeToolVault("# Title\n");
    const stub = new StubLlmClient([
      stubResponse({
        completionId: "c1",
        toolCalls: [
          { id: "call_1", type: "function", function: { name: "no_such_tool", arguments: "{}" } },
        ],
      }),
      stubResponse({ completionId: "c2", content: "ok" }),
    ]);

    const client = new LLMClient("test-model", stub);
    const [, history] = await client.chat("system", "user", [], 2);
    const toolMessages = history.filter((m) => m.role === "tool");
    expect(toolMessages[0].content).toBe("Unknown tool: no_such_tool");
  });

  it("tolerates malformed tool-call arguments JSON", async () => {
    const vault = makeToolVault("# Title\n");
    const tool = new Tool(
      APPLY_EDITS_TOOL.name,
      APPLY_EDITS_TOOL.description,
      APPLY_EDITS_TOOL.parameters,
      applyEdits,
    );
    const stub = new StubLlmClient([
      stubResponse({
        completionId: "c1",
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "apply_edits", arguments: "{not json" },
          },
        ],
      }),
      stubResponse({ completionId: "c2", content: "ok" }),
    ]);

    const client = new LLMClient("test-model", stub);
    const [, history] = await client.chat("system", "user", [tool], 2);
    // fnArgs falls back to {}; applyEdits fails closed with a resolve error.
    const toolMessages = history.filter((m) => m.role === "tool");
    expect(toolMessages[0].content).toContain("RESOLVE_ERROR");
  });
});
