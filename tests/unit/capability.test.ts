// Tool-call capability probe tests. Pins the auto-detection contract:
// a probe response with tool_calls ⇒ "tool_calls"; text-only ⇒
// "no_tool_calls"; a transport failure ⇒ "unknown" (SILENT — no notification
// path exists here, main.ts owns that). Also: no model configured ⇒
// "unknown" without ever probing, and the result is cached per model.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { LLMClient } from "../../src/agent/llm";
import type {
  ChatResponse,
  ChatMessage,
  ChatTool,
  ILlmClient,
} from "../../src/agent/llm_client";
import {
  detectToolCallSupport,
  setProbeClientFactory,
  resetCapabilityCache,
} from "../../src/agent/capability";
import { updateSettings, defaultSettings } from "../../src/config";

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

function toolCallResponse(): ChatResponse {
  return {
    completionId: "c",
    role: "assistant",
    content: null,
    usage: USAGE,
    toolCalls: [
      { id: "call_1", type: "function", function: { name: "ping", arguments: "{}" } },
    ],
  };
}

function contentOnlyResponse(): ChatResponse {
  return { completionId: "c", role: "assistant", content: "pong", usage: USAGE };
}

function stubFactory(stub: ILlmClient): void {
  setProbeClientFactory(() => new LLMClient("probe-model", stub));
}

beforeEach(() => {
  resetCapabilityCache();
  updateSettings({ agent: { model: "probe-model", thinking: { chat: false, build: false, sort: false } } });
});

afterAll(() => {
  setProbeClientFactory(null);
  updateSettings(defaultSettings());
});

describe("tool-call capability detection", () => {
  it("detects tool_calls when the probe response contains tool_calls", async () => {
    stubFactory(new StubLlmClient([toolCallResponse()]));
    expect(await detectToolCallSupport()).toBe("tool_calls");
  });

  it("detects no_tool_calls when the probe answers in text only", async () => {
    stubFactory(new StubLlmClient([contentOnlyResponse()]));
    expect(await detectToolCallSupport()).toBe("no_tool_calls");
  });

  it("returns unknown (silently) when the probe fails", async () => {
    stubFactory(new StubLlmClient([])); // empty queue → chatCompletion throws
    expect(await detectToolCallSupport()).toBe("unknown");
  });

  it("returns unknown without probing when no model is configured", async () => {
    updateSettings({ agent: { model: "", thinking: { chat: false, build: false, sort: false } } });
    let probed = false;
    setProbeClientFactory(() => {
      probed = true;
      throw new Error("must not probe without a model");
    });
    expect(await detectToolCallSupport()).toBe("unknown");
    expect(probed).toBe(false);
  });

  it("caches the result per model so the probe runs once", async () => {
    stubFactory(new StubLlmClient([toolCallResponse()]));
    expect(await detectToolCallSupport()).toBe("tool_calls");
    // Same model: must come from cache (a second probe would throw — empty queue).
    expect(await detectToolCallSupport()).toBe("tool_calls");
  });

  it("re-probes when the model changes", async () => {
    stubFactory(new StubLlmClient([toolCallResponse()]));
    expect(await detectToolCallSupport()).toBe("tool_calls");

    updateSettings({ agent: { model: "other-model", thinking: { chat: false, build: false, sort: false } } });
    stubFactory(new StubLlmClient([contentOnlyResponse()]));
    expect(await detectToolCallSupport()).toBe("no_tool_calls");
  });
});
