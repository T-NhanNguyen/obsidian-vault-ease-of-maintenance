// Reasoning-wiring tests — pin that the ONE global reasoning setting reaches
// each provider in that provider's own shape, and that a provider which
// rejects the parameter can never block the call (fail-open retry).
//
// Local (OMLX/llama.cpp-style) servers take thinking switches through
// chat_template_kwargs; OpenRouter takes its native `reasoning` object;
// generic OpenAI-compatible hosts take reasoning_effort. Hosted providers must
// never see chat_template_kwargs (they reject unknown params). A `null`
// reasoning setting means "send nothing at all" — the capability probe's mode.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { LLMClient } from "../../src/agent/llm";
import { getLlmClient } from "../../src/agent/llm_client";
import { postJsonViaRequestUrl } from "../../src/http";
import { updateSettings, defaultSettings, type ReasoningSettings } from "../../src/config";

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

const REASONING_OFF: ReasoningSettings = { enabled: false, effort: "medium" };
const REASONING_ON_HIGH: ReasoningSettings = { enabled: true, effort: "high" };

function mockOkResponse(): void {
  vi.mocked(postJsonViaRequestUrl).mockResolvedValue({ status: 200, ok: true, body: OK_BODY });
}

function lastPayload(): Record<string, unknown> {
  const calls = vi.mocked(postJsonViaRequestUrl).mock.calls;
  return calls[calls.length - 1][2] as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(postJsonViaRequestUrl).mockReset();
});

afterAll(() => {
  updateSettings(defaultSettings());
});

describe("reasoning payload per provider", () => {
  beforeEach(() => {
    mockOkResponse();
  });

  it("sends the local off-switch through chat_template_kwargs", async () => {
    const client = getLlmClient("local", "m", "k", "http://127.0.0.1:8000/v1", REASONING_OFF);
    await client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    expect(lastPayload().chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("sends the local on-switch with the chosen effort", async () => {
    const client = getLlmClient("local", "m", "k", "http://127.0.0.1:8000/v1", REASONING_ON_HIGH);
    await client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    expect(lastPayload().chat_template_kwargs).toEqual({
      enable_thinking: true,
      reasoning_effort: "high",
    });
  });

  it("sends OpenRouter its native disabled-reasoning object", async () => {
    const client = getLlmClient(
      "openrouter", "m", "k", "https://openrouter.ai/api/v1", REASONING_OFF,
    );
    await client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    expect(lastPayload().reasoning).toEqual({ enabled: false });
    expect(lastPayload()).not.toHaveProperty("chat_template_kwargs");
  });

  it("sends OpenRouter its native effort when reasoning is on", async () => {
    const client = getLlmClient("openrouter", "m", "k", "https://openrouter.ai/api/v1", {
      enabled: true,
      effort: "minimal",
    });
    await client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    expect(lastPayload().reasoning).toEqual({ enabled: true, effort: "minimal" });
  });

  it("sends reasoning_effort for generic OpenAI-compatible hosts", async () => {
    const client = getLlmClient("openai", "m", "k", "https://api.openai.com/v1", REASONING_ON_HIGH);
    await client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    expect(lastPayload().reasoning_effort).toBe("high");
  });

  it("sends no reasoning params at all when the setting is null", async () => {
    const client = getLlmClient("openrouter", "m", "k", "https://openrouter.ai/api/v1", null);
    await client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    const payload = lastPayload();
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("chat_template_kwargs");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("LLMClient applies the global reasoning setting to the wire", async () => {
    updateSettings({
      api: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" },
      agent: { model: "m" },
      reasoning: { enabled: false, effort: "medium" },
    });

    await new LLMClient().chat("s", "u", null, 1);
    expect(lastPayload().reasoning).toEqual({ enabled: false });

    await new LLMClient(undefined, undefined, { reasoning: REASONING_ON_HIGH }).chat("s", "u", null, 1);
    expect(lastPayload().reasoning).toEqual({ enabled: true, effort: "high" });

    // null = send nothing (the capability probe's mode).
    await new LLMClient(undefined, undefined, { reasoning: null }).chat("s", "u", null, 1);
    expect(lastPayload()).not.toHaveProperty("reasoning");
  });
});

describe("build-side output cap", () => {
  beforeEach(() => {
    mockOkResponse();
  });

  it("sends max_tokens to OpenRouter when the caller passes a cap", async () => {
    const client = getLlmClient(
      "openrouter", "m", "k", "https://openrouter.ai/api/v1", REASONING_OFF,
    );
    await client.chatCompletion("m", [{ role: "user", content: "hi" }], null, { maxTokens: 1000 });
    expect(lastPayload().max_tokens).toBe(1000);
  });

  it("sends max_tokens to a local server too", async () => {
    const client = getLlmClient("local", "m", "k", "http://127.0.0.1:8000/v1", REASONING_OFF);
    await client.chatCompletion("m", [{ role: "user", content: "hi" }], null, { maxTokens: 800 });
    expect(lastPayload().max_tokens).toBe(800);
  });

  it("sends max_tokens to a generic OpenAI host too", async () => {
    const client = getLlmClient("openai", "m", "k", "https://api.openai.com/v1", REASONING_OFF);
    await client.chatCompletion("m", [{ role: "user", content: "hi" }], null, { maxTokens: 600 });
    expect(lastPayload().max_tokens).toBe(600);
  });

  it("sends no max_tokens when the caller omits the cap", async () => {
    const client = getLlmClient(
      "openrouter", "m", "k", "https://openrouter.ai/api/v1", REASONING_OFF,
    );
    await client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    expect(lastPayload()).not.toHaveProperty("max_tokens");
  });
});

describe("reasoning fail-open", () => {
  it("retries once without the reasoning params when a provider rejects them", async () => {
    vi.mocked(postJsonViaRequestUrl)
      .mockResolvedValueOnce({
        status: 400,
        ok: false,
        body: { error: { message: "unsupported parameter: reasoning" } },
      })
      .mockResolvedValue({ status: 200, ok: true, body: OK_BODY });

    const client = getLlmClient(
      "openrouter", "m", "k", "https://openrouter.ai/api/v1", REASONING_OFF,
    );
    const result = await client.chatCompletion("m", [{ role: "user", content: "hi" }]);

    expect(result.content).toBe("ok");
    expect(vi.mocked(postJsonViaRequestUrl).mock.calls.length).toBe(2);
    expect(lastPayload()).not.toHaveProperty("reasoning");
  });
});

describe("server error envelope + retry classification (R2.6)", () => {
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

    const client = getLlmClient("local", "m", "k", "http://127.0.0.1:8000/v1", REASONING_OFF);
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

    const client = getLlmClient("local", "m", "k", "http://127.0.0.1:8000/v1", REASONING_OFF);
    const p = client.chatCompletion("m", [{ role: "user", content: "hi" }]);
    const rejection = expect(p).rejects.toThrow(/LLM server error: upstream rate limited/);
    await vi.advanceTimersByTimeAsync(10000);
    await rejection;
    expect(vi.mocked(postJsonViaRequestUrl).mock.calls.length).toBe(3); // DEFAULT_MAX_RETRIES
    vi.useRealTimers();
  });
});
