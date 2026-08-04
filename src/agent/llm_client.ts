// LLM client abstraction layer.
// Provider-agnostic, fetch-based. Ported from src/agent/llm_client.py

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

export interface ILlmClient {
  chatCompletion(
    model: string,
    messages: Array<Record<string, any>>,
    tools?: Array<Record<string, any>> | null,
  ): Promise<ChatResponse>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT = 600_000; // ms
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

  constructor(baseUrl: string, model: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    this.model = model;
    this.apiKey = apiKey;
  }

  async chatCompletion(
    model: string,
    messages: Array<Record<string, any>>,
    tools?: Array<Record<string, any>> | null,
  ): Promise<ChatResponse> {
    const endpoint = `${this.baseUrl}/v1/chat/completions`;
    const payload: Record<string, any> = {
      model: model || this.model,
      messages,
    };
    if (tools) {
      payload.tools = tools;
      payload.tool_choice = "auto";
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
    messages: Array<Record<string, any>>,
    tools?: Array<Record<string, any>> | null,
  ): Promise<ChatResponse> {
    const payload: Record<string, any> = { model, messages };
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
    messages: Array<Record<string, any>>,
    tools?: Array<Record<string, any>> | null,
  ): Promise<ChatResponse> {
    const endpoint = `${this.baseUrl}/chat/completions`;
    const payload: Record<string, any> = { model, messages };
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
  payload: Record<string, any>,
  headers: Record<string, string>,
  clientLabel: string,
  opts: { handle503?: boolean; handle429?: boolean } = {},
): Promise<ChatResponse> {
  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT);

  for (let attempt = 0; attempt < DEFAULT_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: timeoutSignal,
      });

      if (opts.handle503 && response.status === 503) {
        const wait = Math.pow(DEFAULT_BACKOFF_BASE, attempt) * 5;
        console.warn(`${clientLabel}: server loading (503). Retrying in ${wait}s (attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES})`);
        await sleep(wait * 1000);
        continue;
      }

      if (opts.handle429 && response.status === 429) {
        const wait = Math.min(Math.pow(DEFAULT_BACKOFF_BASE, attempt) * 5, 60);
        console.warn(`${clientLabel}: rate limited (429). Retrying in ${wait}s (attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES})`);
        await sleep(wait * 1000);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const raw = await response.json();
      return parseResponse(raw);
    } catch (e: any) {
      const delay = Math.pow(DEFAULT_BACKOFF_BASE, attempt) * 2;
      console.error(`${clientLabel}: error on attempt ${attempt + 1}/${DEFAULT_MAX_RETRIES}: ${e.message}`);
      if (attempt === DEFAULT_MAX_RETRIES - 1) throw e;
      await sleep(delay * 1000);
    }
  }

  throw new Error(`${clientLabel}: Failed after ${DEFAULT_MAX_RETRIES} attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseResponse(data: Record<string, any>): ChatResponse {
  const choice = data.choices[0];
  const msg = choice.message;
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

function extractReasoning(msg: Record<string, any>, content: string): string | null {
  const modelExtra = msg.model_extra;
  if (modelExtra && typeof modelExtra === "object" && modelExtra.reasoning) {
    return modelExtra.reasoning;
  }
  if (msg.reasoning_content) return String(msg.reasoning_content);
  if (content.includes("<think>") && content.includes("</think>")) {
    const match = content.match(/<think>([\s\S]*?)<\/think>/);
    if (match) return match[1].trim();
  }
  return null;
}

function mapToolCalls(raw: any): ToolCallData[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  return raw.map((tc: any) => ({
    id: tc.id,
    type: tc.type || "function",
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments,
    },
  }));
}

function normalizeUsage(usage: any): UsageData {
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
): ILlmClient {
  const p = provider.toLowerCase();

  if (p === "local") {
    return new LocalLlmClient(baseUrl || LOCAL_DEFAULT_BASE, model, apiKey || undefined);
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
