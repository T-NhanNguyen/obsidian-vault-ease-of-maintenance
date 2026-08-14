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
// Probe failures are SILENT by design: on a fresh install with no model
// configured the user must not be notified that the model is unreachable.
// Notification happens once at startup only when detection SUCCEEDS (see
// main.ts runCapabilityStartupNotice).

import { errorMessage } from "../errors";
import { settings } from "../config";
import { LLMClient, Tool } from "./llm";

export type ToolCallCapability = "tool_calls" | "no_tool_calls" | "unknown";

const PROBE_SYSTEM_PROMPT =
  "You have a tool named ping. You MUST call it now — do not answer in text.";
const PROBE_USER_MESSAGE = "Call the ping tool.";

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
    return madeToolCall ? "tool_calls" : "no_tool_calls";
  } catch (e) {
    console.warn(`[capability] Tool-call probe failed: ${errorMessage(e)}`);
    return "unknown";
  }
}
