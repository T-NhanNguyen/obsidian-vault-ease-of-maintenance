// LLM client abstraction layer.
// Provider-agnostic, fetch-based. Ported from src/agent/llm_client.py

import { postJsonViaRequestUrl } from "../http";
import { errorMessage } from "../errors";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  private enableThinking: boolean;

  constructor(baseUrl: string, model: string, apiKey?: string, enableThinking: boolean = false) {
    this.baseUrl = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    this.model = model;
    this.apiKey = apiKey;
    this.enableThinking = enableThinking;
  }

  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    tools?: ChatTool[] | null,
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
    // gemma-4-31b-it (and other reasoning models) emit a long thinking phase
    // (reasoning_content) before any visible answer. A feature gate of OFF
    // (config.yaml agent.thinking.*, sent per-feature) sends the explicit
    // off-switch to local (OMLX/llama.cpp-style) servers. Hosted providers
    // do not support this parameter, so it is sent by the local client only.
    if (!this.enableThinking) {
      payload.chat_template_kwargs = { enable_thinking: false };
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    return postWithRetry(endpoint, payload, headers, "LocalLlmClient", { handle503: true });
  }
}

// ---------------------------------------------------------------------------
// OpenRouterClient
// ---------------------------------------------------------------------------

export class OpenRouterClient implements ILlmClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = ensureChatEndpoint(baseUrl);
  }

  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    tools?: ChatTool[] | null,
  ): Promise<ChatResponse> {
    const payload: Record<string, unknown> = { model, messages };
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    return postWithRetry(this.baseUrl, payload, {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    }, "OpenRouterClient", { handle429: true });
  }
}

// ---------------------------------------------------------------------------
// OpenAiClient
// ---------------------------------------------------------------------------

export class OpenAiClient implements ILlmClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(apiKey: string, baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/chat\/completions$/, "").replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async chatCompletion(
    model: string,
    messages: ChatMessage[],
    tools?: ChatTool[] | null,
  ): Promise<ChatResponse> {
    const endpoint = `${this.baseUrl}/chat/completions`;
    const payload: Record<string, unknown> = { model, messages };
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = "auto";
    }
    return postWithRetry(endpoint, payload, {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    }, "OpenAiClient", { handle429: true });
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
  opts: { handle503?: boolean; handle429?: boolean } = {},
): Promise<ChatResponse> {
  for (let attempt = 0; attempt < DEFAULT_MAX_RETRIES; attempt++) {
    try {
      const result = await postJsonViaRequestUrl(endpoint, headers, payload);

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

export function getLlmClient(
  provider: string,
  model: string,
  apiKey?: string | null,
  baseUrl?: string | null,
  enableThinking: boolean = false,
): ILlmClient {
  const p = provider.toLowerCase();

  if (p === "local") {
    return new LocalLlmClient(baseUrl || LOCAL_DEFAULT_BASE, model, apiKey || undefined, enableThinking);
  }
  if (p === "openai") {
    return new OpenAiClient(apiKey || "", baseUrl || OPENROUTER_DEFAULT_BASE);
  }
  // Default: openrouter
  return new OpenRouterClient(apiKey || "", baseUrl || OPENROUTER_DEFAULT_BASE);
}

export function detectProvider(baseUrl: string): string {
  const normalized = baseUrl.toLowerCase();
  if (normalized.includes("127.0.0.1") || normalized.includes("localhost")) return "local";
  if (normalized.includes("openrouter")) return "openrouter";
  return "openai";
}
