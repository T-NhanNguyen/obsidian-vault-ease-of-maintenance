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

describe("server error envelope + retry classification (R2.6)", () => {
  beforeEach(() => {
    vi.mocked(postJsonViaRequestUrl).mockClear();
  });

  it("surfaces the server error message and never retries a memory rejection", async () => {
    vi.mocked(postJsonViaRequestUrl).mockResolvedValue({
      status: 200,
      ok: true,
      body: {
        error: {
          message:
            "oMLX prefill memory guard rejected this prompt: Prefill context too large " +
            "for available memory (preflight safety guard, kv_len=18400): predicted peak " +
            "would require ~28.20 GB ... prefill safety cap is 28.12 GB",
        },
      },
    });

    const client = getLlmClient("local", "m", "k", "http://127.0.0.1:8000/v1", false);
    const err = await client
      .chatCompletion("m", [{ role: "user", content: "hi" }])
      .then(() => null, (e: unknown) => e);

    expect(String((err as Error).message)).toContain("LLM server error: oMLX prefill memory guard");
    expect(String((err as Error).message)).not.toContain("Malformed LLM response");
    // Exactly one attempt — retrying a memory rejection re-peaks memory.
    expect(vi.mocked(postJsonViaRequestUrl).mock.calls.length).toBe(1);
  });

  it("still retries non-memory server errors (behavior preserved)", async () => {
    vi.mocked(postJsonViaRequestUrl).mockResolvedValue({
      status: 200,
      ok: true,
      body: { error: { message: "upstream rate limited" } },
    });
    // sleep() uses window.setTimeout; shim for the node test env.
    (globalThis as unknown as { window: unknown }).window = globalThis;
    vi.useFakeTimers();

    const client = getLlmClient("local", "m", "k", "http://127.0.0.1:8000/v1", false);
    const p = client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    const rejection = expect(p).rejects.toThrow(/LLM server error: upstream rate limited/);
    await vi.advanceTimersByTimeAsync(10000);
    await rejection;
    expect(vi.mocked(postJsonViaRequestUrl).mock.calls.length).toBe(3); // DEFAULT_MAX_RETRIES
    vi.useRealTimers();
  });
});
