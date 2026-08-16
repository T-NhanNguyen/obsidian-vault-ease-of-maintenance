// Thinking-gate wiring tests — pin that the LLMClient options.enableThinking
// override reaches the wire payload for local (OMLX/llama.cpp-style) clients.
//
// chat_template_kwargs.{enable_thinking:false} must be sent only when the gate
// is off; hosted providers (OpenAI/OpenRouter) reject unknown params, so they
// must never see it. The gate is local-client-only by design — see
// design/config-layering-and-agent-driven-chat.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { LLMClient } from "../../src/agent/llm";
import { getLlmClient } from "../../src/agent/llm_client";
import { postJsonViaRequestUrl } from "../../src/http";
import { updateSettings, defaultSettings } from "../../src/config";

vi.mock("../../src/http", () => ({
  postJsonViaRequestUrl: vi.fn(),
  postJsonViaFetch: vi.fn(),
}));

const OK_BODY = {
  id: "cmpl",
  choices: [
    { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function mockOkResponse(): void {
  vi.mocked(postJsonViaRequestUrl).mockResolvedValue({ status: 200, ok: true, body: OK_BODY });
}

function lastPayload(): Record<string, unknown> {
  const calls = vi.mocked(postJsonViaRequestUrl).mock.calls;
  return calls[calls.length - 1][2] as Record<string, unknown>;
}

afterAll(() => {
  updateSettings(defaultSettings());
});

describe("thinking gate payload", () => {
  beforeEach(() => {
    mockOkResponse();
  });

  it("sends enable_thinking:false for a local client with the gate off", async () => {
    const client = getLlmClient("local", "gemma-4-31b-it-4bit", "k", "http://127.0.0.1:8000/v1", false);
    await client.chatCompletion("gemma-4-31b-it-4bit", [{ role: "user", content: "hi" }]);
    expect(lastPayload().chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("omits chat_template_kwargs for a local client with the gate on", async () => {
    const client = getLlmClient("local", "gemma-4-31b-it-4bit", "k", "http://127.0.0.1:8000/v1", true);
    await client.chatCompletion("gemma-4-31b-it-4bit", [{ role: "user", content: "hi" }]);
    expect(lastPayload()).not.toHaveProperty("chat_template_kwargs");
  });

  it("never sends chat_template_kwargs to hosted clients", async () => {
    const client = getLlmClient("openrouter", "m", "k", "https://openrouter.ai/api/v1", false);
    await client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    expect(lastPayload()).not.toHaveProperty("chat_template_kwargs");
  });

  it("LLMClient options.enableThinking overrides the config gate on the wire", async () => {
    updateSettings({
      api: { baseUrl: "http://127.0.0.1:8000/v1", apiKey: "k" },
      agent: { model: "gemma-4-31b-it-4bit", thinking: { chat: false, build: false, sort: false } },
    });

    // Per-run override ON: no off-switch sent (server default = thinking on).
    await new LLMClient(undefined, undefined, { enableThinking: true }).chat("s", "u", null, 1);
    expect(lastPayload()).not.toHaveProperty("chat_template_kwargs");

    // Per-run override OFF and default both send the off-switch (gate is off).
    await new LLMClient(undefined, undefined, { enableThinking: false }).chat("s", "u", null, 1);
    expect(lastPayload().chat_template_kwargs).toEqual({ enable_thinking: false });

    await new LLMClient().chat("s", "u", null, 1);
    expect(lastPayload().chat_template_kwargs).toEqual({ enable_thinking: false });
  });
});
