// Tool-call capability detection — auto-detect whether the configured chat
// model can emit OpenAI-format tool_calls (the wire format the agent loop and
// search/cite tools depend on). Small models (e.g. gemma-3-4b-it-qat-4bit)
// may refuse tool calling, hallucinate, or emit model-native pseudo-code
// (Gemma `tool_code`) that the server never converts — see
// .dev-vault/tips/gemma-3-4b-no-openai-tool-calls.md.
//
// The probe is a single tiny chat completion with a throwaway `ping` tool and
// a forced "MUST call it" prompt: a real tool_calls response ⇒ capable;
// content-only ⇒ not capable; any transport error ⇒ `unknown` (the caller
// falls back to the current agentic behavior and the probe is retried lazily).
//
// probeConnection() is the same ping exposed as a reusable result — the
// settings page's "Test connection" button calls it too, so the capability
// detector and the button share one code path (DRY).
//
// Probe failures are SILENT by design for detection: on a fresh install with
// no model configured the user must not be notified that the model is
// unreachable. Notification happens once at startup only when detection
// SUCCEEDS (see main.ts runCapabilityStartupNotice); the settings button
// surfaces probeConnection()'s result directly to the user.

import { errorMessage } from "../errors";
import { settings } from "../config";
import { LLMClient, Tool } from "./llm";
import { readPromptSection } from "../definitions";
import probePromptsMd from "../../maintainer-definitions/capability-probe.md";

export type ToolCallCapability = "tool_calls" | "no_tool_calls" | "unknown";

/** Result of the shared connection probe — the reusable ping the settings
 * page's "Test connection" button and the capability detector both use.
 * connected is true whenever the chat endpoint responded (2xx); toolCalls
 * reports what the probe model actually did. error is set only on failure. */
export interface ConnectionProbeResult {
  connected: boolean;
  toolCalls: boolean;
  error?: string;
}

const PROBE_SYSTEM_PROMPT = readPromptSection(probePromptsMd, "Probe system prompt");
const PROBE_USER_MESSAGE = readPromptSection(probePromptsMd, "Probe user message");

const PING_TOOL = new Tool(
  "ping",
  "A test tool. Returns the string 'pong'.",
  { type: "object", properties: {}, required: [] },
  () => "pong",
);

let cached: ToolCallCapability = "unknown";
let cachedForModel: string | null = null;
let probing: Promise<ToolCallCapability> | null = null;

// Test seam only: lets a fake ILlmClient drive the probe without HTTP. The
// default branch is the real client (see llm.ts constructor comment).
let probeClientFactory: (() => LLMClient) | null = null;

export function setProbeClientFactory(factory: (() => LLMClient) | null): void {
  probeClientFactory = factory;
}

export function resetCapabilityCache(): void {
  cached = "unknown";
  cachedForModel = null;
  probing = null;
}

export async function detectToolCallSupport(): Promise<ToolCallCapability> {
  const model = settings.agent.model;
  if (model && model === cachedForModel) return cached;
  if (!model) return "unknown";
  if (probing) return probing;

  probing = doProbe(model);
  try {
    const result = await probing;
    cached = result;
    cachedForModel = model;
    return result;
  } finally {
    probing = null;
  }
}

async function doProbe(model: string): Promise<ToolCallCapability> {
  const result = await probeConnection();
  if (!result.connected) {
    console.warn(`[capability] Tool-call probe failed: ${result.error}`);
    return "unknown";
  }
  return result.toolCalls ? "tool_calls" : "no_tool_calls";
}

/**
 * Ping the configured API exactly like the tool-call probe: one tiny chat
 * completion with the throwaway ping tool. 2xx ⇒ connected (the API key and
 * base URL are reachable); any transport/HTTP error ⇒ connected:false with a
 * readable error. Used by detectToolCallSupport (above) and by the settings
 * page's "Test connection" button — one code path, no duplication.
 */
export async function probeConnection(): Promise<ConnectionProbeResult> {
  try {
    const client = probeClientFactory
      ? probeClientFactory()
      : new LLMClient(undefined, undefined, { enableThinking: false });
    const [, history] = await client.chat(
      PROBE_SYSTEM_PROMPT,
      PROBE_USER_MESSAGE,
      [PING_TOOL],
      1,
    );
    const madeToolCall = history.some(
      m => m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0,
    );
    return { connected: true, toolCalls: madeToolCall };
  } catch (e) {
    return { connected: false, toolCalls: false, error: errorMessage(e) };
  }
}
