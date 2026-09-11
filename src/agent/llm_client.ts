// LLM client abstraction layer.
// Provider-agnostic, fetch-based. Ported from src/agent/llm_client.py

import { postJsonViaRequestUrl } from "../http";
import { errorMessage } from "../errors";
import { debugLog } from "../debug";
import type { ReasoningSettings } from "../config";

/** Payload keys a provider may reject when it has no thinking support. The
 * retry loop drops whichever are present and tries once more, so a model
 * without reasoning cannot be blocked by the reasoning setting. */
const LOCAL_REASONING_KEYS = ["chat_template_kwargs"];
const OPENROUTER_REASONING_KEYS = ["reasoning"];
const OPENAI_REASONING_KEYS = ["reasoning_effort"];

/** Local (OMLX / llama.cpp-style) servers take thinking switches through the
 * chat template: `enable_thinking` is the portable on/off, and the effort is
 * handed to the template as well (an unused kwarg is inert, and a server that
 * rejects it is covered by the fail-open retry). */
function localReasoningPayload(reasoning: ReasoningSettings): Record<string, unknown> {
  return reasoning.enabled
    ? { enable_thinking: true, reasoning_effort: reasoning.effort }
    : { enable_thinking: false };
}

/** OpenRouter exposes reasoning natively: `enabled` switches it off, `effort`
 * picks the level. */
function openRouterReasoningPayload(reasoning: ReasoningSettings): Record<string, unknown> {
  return reasoning.enabled
    ? { enabled: true, effort: reasoning.effort }
    : { enabled: false };
}

/** Build-side output cap. Without it the provider applies its own ceiling (up
 * to 65536 tokens on some hosted models), so one stalled call can generate for
 * many minutes. Omitted = no cap is sent. */
function applyMaxOutputTokens(
  payload: Record<string, unknown>,
  opts?: ChatCompletionOptions,
): void {
  if (opts?.maxTokens) payload.max_tokens = opts.maxTokens;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-call transport options. `maxTokens` caps the completion; a provider
 * that hits the cap answers with finishReason "length". */
export interface ChatCompletionOptions {
  maxTokens?: number;
}

export interface ChatResponse {
  completionId: string;
  content: string;
  role: string;
  reasoning?: string;
  toolCalls?: ToolCallData[];
  usage: UsageData;
  finishReason?: string;
}

export interface ToolCallData {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface UsageData {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// Request-side wire shapes — producer-controlled by this plugin.
export interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: ToolCallData[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatTool {
  type?: string;
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// Response-side wire shapes — OpenAI-compatible subset actually consumed.
interface RawChatMessage {
  role?: string;
  content?: string | null;
  tool_calls?: RawToolCall[];
  reasoning_content?: string;
  model_extra?: Record<string, unknown>;
}

interface RawToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatCompletionResponse {
  id?: string;
  choices?: Array<{
    message?: RawChatMessage;
    finish_reason?: string;
  }>;
  usage?: ChatUsage;
  /** Server-side error envelope (local LLM servers) — no choices present. */
  error?: { message?: string };
}

/** Errors that must NOT be retried: retrying a prefill-memory rejection
 * re-peaks memory on every attempt (R2.6). */
const MEMORY_REJECTION_RE = /prefill|kv_len|context too large|safety cap|memory/i;

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ILlmClient {
  chatCompletion(
    model: string,
    messages: ChatMessage[],
    tools?: ChatTool[] | null,
    opts?: ChatCompletionOptions,
  ): Promise<ChatResponse>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE = 2;
const OPENROUTER_DEFAULT_BASE = "https://openrouter.ai/api/v1";
const LOCAL_DEFAULT_BASE = "http://127.0.0.1:8000";

// ---------------------------------------------------------------------------
// LocalLlmClient
// ---------------------------------------------------------------------------

export class LocalLlmClient implements ILlmClient {
  private baseUrl: string;
  private model: string;
  private apiKey?: string;
  private reasoning: ReasoningSettings | null;

  constructor(
    baseUrl: string,
    model: string,
    apiKey?: string,
    reasoning: ReasoningSettings | null = null,
  ) {
    this.baseUrl = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    this.model = model;
    this.apiKey = apiKey;
    this.reasoning = reasoning;
  }

  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    tools?: ChatTool[] | null,
    opts?: ChatCompletionOptions,
  ): Promise<ChatResponse> {
    const endpoint = `${this.baseUrl}/v1/chat/completions`;
    const payload: Record<string, unknown> = {
      model: model || this.model,
      messages,
    };
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    applyMaxOutputTokens(payload, opts);
    // Reasoning models emit a long thinking phase (reasoning_content) before
    // any visible answer. The global reasoning setting sends the switch to
    // local servers; `null` means "send nothing" (the capability probe uses
    // that so probing cannot be degraded by a disabled-thinking payload).
    if (this.reasoning) {
      payload.chat_template_kwargs = localReasoningPayload(this.reasoning);
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    return postWithRetry(endpoint, payload, headers, "LocalLlmClient", {
      handle503: true,
      reasoningKeys: LOCAL_REASONING_KEYS,
    });
  }
}

// ---------------------------------------------------------------------------
// OpenRouterClient
// ---------------------------------------------------------------------------

export class OpenRouterClient implements ILlmClient {
  private baseUrl: string;
  private apiKey: string;
  private reasoning: ReasoningSettings | null;

  constructor(apiKey: string, baseUrl: string, reasoning: ReasoningSettings | null = null) {
    this.apiKey = apiKey;
    this.baseUrl = ensureChatEndpoint(baseUrl);
    this.reasoning = reasoning;
  }

  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    tools?: ChatTool[] | null,
    opts?: ChatCompletionOptions,
  ): Promise<ChatResponse> {
    const payload: Record<string, unknown> = { model, messages };
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    applyMaxOutputTokens(payload, opts);
    // OpenRouter's native reasoning control — the hosted equivalent of the
    // local chat_template_kwargs switch. Hosted providers never see
    // chat_template_kwargs, which they reject.
    if (this.reasoning) {
      payload.reasoning = openRouterReasoningPayload(this.reasoning);
    }
    return postWithRetry(this.baseUrl, payload, {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    }, "OpenRouterClient", { handle429: true, reasoningKeys: OPENROUTER_REASONING_KEYS });
  }
}

// ---------------------------------------------------------------------------
// OpenAiClient
// ---------------------------------------------------------------------------

export class OpenAiClient implements ILlmClient {
  private baseUrl: string;
  private apiKey: string;
  private reasoning: ReasoningSettings | null;

  constructor(apiKey: string, baseUrl: string, reasoning: ReasoningSettings | null = null) {
    this.baseUrl = baseUrl.replace(/\/chat\/completions$/, "").replace(/\/$/, "");
    this.apiKey = apiKey;
    this.reasoning = reasoning;
  }

  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    tools?: ChatTool[] | null,
    opts?: ChatCompletionOptions,
  ): Promise<ChatResponse> {
    const endpoint = `${this.baseUrl}/chat/completions`;
    const payload: Record<string, unknown> = { model, messages };
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    applyMaxOutputTokens(payload, opts);
    // OpenAI-compatible hosts take the standard reasoning_effort field when
    // ON. There is no portable way to force thinking OFF here, so OFF sends
    // nothing rather than risking a rejected parameter.
    if (this.reasoning?.enabled) {
      payload.reasoning_effort = this.reasoning.effort;
    }
    return postWithRetry(endpoint, payload, {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    }, "OpenAiClient", { handle429: true, reasoningKeys: OPENAI_REASONING_KEYS });
  }
}

// ---------------------------------------------------------------------------
// Shared transport
// ---------------------------------------------------------------------------

async function postWithRetry(
  endpoint: string,
  payload: Record<string, unknown>,
  headers: Record<string, string>,
  clientLabel: string,
  opts: { handle503?: boolean; handle429?: boolean; reasoningKeys?: string[] } = {},
): Promise<ChatResponse> {
  let reasoningStripped = false;
  for (let attempt = 0; attempt < DEFAULT_MAX_RETRIES; attempt++) {
    const attemptStartedAt = Date.now();
    try {
      debugLog(
        "llm",
        `${clientLabel} attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES}: POST ${endpoint} ` +
          `(${JSON.stringify(payload).length} payload chars)`,
      );
      const result = await postJsonViaRequestUrl(endpoint, headers, payload);
      debugLog(
        "llm",
        `${clientLabel} attempt ${attempt + 1}: HTTP ${result.status} after ${Date.now() - attemptStartedAt}ms`,
      );

      // Non-blocking reasoning: a provider that rejects the reasoning fields
      // outright gets one retry without them, so a model without thinking
      // support is never gated by the reasoning setting.
      if (result.status === 400 && !reasoningStripped && opts.reasoningKeys?.length) {
        const removed = opts.reasoningKeys.filter((key) => key in payload);
        if (removed.length > 0) {
          for (const key of removed) delete payload[key];
          reasoningStripped = true;
          console.warn(
            `${clientLabel}: HTTP 400 with ${removed.join(", ")} — retrying without it ` +
            "(this model or provider does not accept reasoning controls).",
          );
          continue;
        }
      }

      if (opts.handle503 && result.status === 503) {
        const wait = Math.pow(DEFAULT_BACKOFF_BASE, attempt) * 5;
        console.warn(`${clientLabel}: server loading (503). Retrying in ${wait}s (attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES})`);
        await sleep(wait * 1000);
        continue;
      }

      if (opts.handle429 && result.status === 429) {
        const wait = Math.min(Math.pow(DEFAULT_BACKOFF_BASE, attempt) * 5, 60);
        console.warn(`${clientLabel}: rate limited (429). Retrying in ${wait}s (attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES})`);
        await sleep(wait * 1000);
        continue;
      }

      if (!result.ok) {
        throw new Error(`HTTP ${result.status}`);
      }

      return parseResponse(result.body as ChatCompletionResponse);
    } catch (e) {
      const message = errorMessage(e);
      if ((e as { isRequestTimeout?: boolean } | null)?.isRequestTimeout) {
        // Transport timeout — the request already burned the full ceiling;
        // retrying would re-burn it. Fail the leg so the caller can report a
        // bounded failure and keep whatever is already on disk.
        debugLog("llm", `${clientLabel} attempt ${attempt + 1}: TIMEOUT after ${Date.now() - attemptStartedAt}ms`);
        throw e;
      }
      if (MEMORY_REJECTION_RE.test(message)) {
        // Prefill/memory rejection — throw immediately, never retry (each
        // attempt would re-prefill the same oversized context).
        throw e;
      }
      const delay = Math.pow(DEFAULT_BACKOFF_BASE, attempt) * 2;
      console.error(`${clientLabel}: error on attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES}: ${message}`);
      if (attempt === DEFAULT_MAX_RETRIES - 1) throw e;
      await sleep(delay * 1000);
    }
  }

  throw new Error(`${clientLabel}: Failed after ${DEFAULT_MAX_RETRIES} attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseResponse(data: ChatCompletionResponse): ChatResponse {
  if (data && typeof data === "object" && data.error) {
    // The server answered with an error envelope — surface its message
    // verbatim instead of mislabeling it as a malformed response.
    const message = typeof data.error.message === "string" ? data.error.message : "";
    throw new Error(
      `LLM server error: ${message || JSON.stringify(data.error).slice(0, 200)}`,
    );
  }
  if (!data || typeof data !== "object" || !Array.isArray(data.choices) || !data.choices[0]) {
    // Surface what the server ACTUALLY returned — "missing choices" is
    // usually a local-server template/error page, not a plugin fault.
    const snippet = JSON.stringify(data).slice(0, 300);
    throw new Error(
      `Malformed LLM response: missing choices — server returned ${snippet || "(empty body)"}`,
    );
  }
  const choice = data.choices[0];
  const msg = choice.message ?? {};
  let content = msg.content || "";

  // Extract reasoning
  const reasoning = extractReasoning(msg, content);
  if (reasoning && content.includes(`<think>${reasoning}</think>`)) {
    content = content.replace(`<think>${reasoning}</think>`, "").trim();
  }

  return {
    completionId: data.id || "",
    content,
    role: msg.role || "assistant",
    reasoning: reasoning || undefined,
    toolCalls: mapToolCalls(msg.tool_calls),
    usage: normalizeUsage(data.usage),
    finishReason: choice.finish_reason || undefined,
  };
}

function extractReasoning(msg: RawChatMessage, content: string): string | null {
  const modelExtra = msg.model_extra;
  if (modelExtra && typeof modelExtra === "object") {
    const modelReasoning = modelExtra.reasoning;
    if (typeof modelReasoning === "string" && modelReasoning) return modelReasoning;
    if ((typeof modelReasoning === "number" || typeof modelReasoning === "boolean") && modelReasoning) {
      return String(modelReasoning);
    }
  }
  if (msg.reasoning_content) return String(msg.reasoning_content);
  if (content.includes("<think>") && content.includes("</think>")) {
    const match = content.match(/<think>([\s\S]*?)<\/think>/);
    if (match) return match[1].trim();
  }
  return null;
}

function mapToolCalls(raw: RawToolCall[] | undefined): ToolCallData[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  return raw.map((tc) => ({
    id: tc.id || "",
    type: tc.type || "function",
    function: {
      name: tc.function?.name || "",
      arguments: tc.function?.arguments || "",
    },
  }));
}

function normalizeUsage(usage: ChatUsage | undefined): UsageData {
  if (!usage || typeof usage !== "object") {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  }
  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);
  const total = Number(usage.total_tokens || prompt + completion);
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total };
}

function ensureChatEndpoint(baseUrl: string): string {
  let url = baseUrl.replace(/\/$/, "");
  if (!url.endsWith("/chat/completions")) {
    url += "/chat/completions";
  }
  return url;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build an LLM client for a provider, with the SAME reasoning setting applied
 * to every provider's native shape (null = send no reasoning params at all).
 */
export function getLlmClient(
  provider: string,
  model: string,
  apiKey?: string | null,
  baseUrl?: string | null,
  reasoning: ReasoningSettings | null = null,
): ILlmClient {
  const p = provider.toLowerCase();

  if (p === "local") {
    return new LocalLlmClient(baseUrl || LOCAL_DEFAULT_BASE, model, apiKey || undefined, reasoning);
  }
  if (p === "openai") {
    return new OpenAiClient(apiKey || "", baseUrl || OPENROUTER_DEFAULT_BASE, reasoning);
  }
  // Default: openrouter
  return new OpenRouterClient(apiKey || "", baseUrl || OPENROUTER_DEFAULT_BASE, reasoning);
}

export function detectProvider(baseUrl: string): string {
  const normalized = baseUrl.toLowerCase();
  if (normalized.includes("127.0.0.1") || normalized.includes("localhost")) return "local";
  if (normalized.includes("openrouter")) return "openrouter";
  return "openai";
}
