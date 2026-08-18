// Clarify harness in the chat runtime — milestone-2 tests. Pins the
// interactive tool-call pattern at the loop level (a fake ILlmClient drives
// the agent loop; the model's clarify tool call surfaces the question and
// the scripted answer resolves the run), the manifest proposal reconciled
// from the run's Q&A, idempotency (a re-run proposes nothing once the
// manifest covers the folders), and the no-tool-call parity (the same
// deterministic questions through the plugin-driven loop on the same chat
// surface). Renderer behavior is manual (DOM) — not exercised here.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { updateSettings, defaultSettings } from "../../src/config";
import { LLMClient } from "../../src/agent/llm";
import type { ChatResponse, ChatMessage, ChatTool, ILlmClient } from "../../src/agent/llm_client";
import {
  detectToolCallSupport,
  setProbeClientFactory,
  resetCapabilityCache,
} from "../../src/agent/capability";
import {
  runChatQuery,
  setChatClientFactory,
  resetChatClientFactory,
  extractClarifyTurns,
  isManifestClarifyRequest,
} from "../../src/agent/runtime_chat";
import {
  openChatSession,
  closeChatSession,
  closeClarifySession,
} from "../../src/agent/chat_session";
import { writeClarifyProposal } from "../../src/agent/clarify";
import { CONVERSATION_DIRS } from "../../src/agent/conversation";

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const GENERATED_H1 = "# vault <!-- Auto-generated from GraphRAG index — review and edit -->";
const AGENT_MODEL = "chat-clarify-model";

class StubLlmClient implements ILlmClient {
  private queue: ChatResponse[];
  readonly received: ChatMessage[][] = [];

  constructor(queue: ChatResponse[]) {
    this.queue = [...queue];
  }

  async chatCompletion(
    _model: string,
    messages: ChatMessage[],
    _tools?: ChatTool[] | null,
  ): Promise<ChatResponse> {
    this.received.push(messages);
    const next = this.queue.shift();
    if (!next) throw new Error("StubLlmClient: response queue exhausted");
    return next!;
  }
}

class FailAfterLlmClient implements ILlmClient {
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
    if (next) return next;
    // The failure the user hit: the local server returned a body without
    // choices on a later turn of the multi-turn tool conversation.
    throw new Error("Malformed LLM response: missing choices");
  }
}

function toolCallResponse(name: string, args: Record<string, unknown>, id = "call_1"): ChatResponse {
  return {
    completionId: "c",
    role: "assistant",
    content: "",
    usage: USAGE,
    toolCalls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function contentOnlyResponse(content: string): ChatResponse {
  return { completionId: "c", role: "assistant", content, usage: USAGE };
}

function makeVault(folders: Record<string, string[]>): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "nm-chat-clarify-"));
  for (const [folder, files] of Object.entries(folders)) {
    const abs = path.join(vaultDir, folder);
    fs.mkdirSync(abs, { recursive: true });
    for (const file of files) fs.writeFileSync(path.join(abs, file), `# ${file}\n`, "utf-8");
  }
  return vaultDir;
}

function writeManifest(vaultDir: string, content: string, name = "_manifest.md"): string {
  fs.writeFileSync(path.join(vaultDir, name), content, "utf-8");
  return name;
}

function filesIn(vaultDir: string, relDir: string): string[] {
  const dir = path.join(vaultDir, relDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.startsWith("session-"));
}

beforeEach(() => {
  resetCapabilityCache();
  resetChatClientFactory();
  closeChatSession();
  closeClarifySession();
  updateSettings({
    vaultPath: "",
    ignorePatterns: "",
    agent: { model: AGENT_MODEL, thinking: { chat: false, build: false, sort: false } },
  });
});

afterAll(() => {
  closeChatSession();
  closeClarifySession();
  setProbeClientFactory(null);
  resetChatClientFactory();
  updateSettings(defaultSettings());
});

describe("chat agent loop clarify interception", () => {
  it("round-trips a clarify tool call: question surfaces, scripted answer resolves, proposal reconciles", async () => {
    const vault = makeVault({
      "10_Stocks": ["IREN.md"],
      "20_AI_Speculations": ["idea.md"],
    });
    writeManifest(
      vault,
      GENERATED_H1 + "\n" +
      "## 10_Stocks/ <!-- stock research -->\n" +
      "     10_Stocks/IREN.md\n",
    );
    updateSettings({ vaultPath: vault });
    openChatSession(vault);

    const chatStub = new StubLlmClient([
      toolCallResponse(
        "clarify",
        { question: "What is the purpose of the folder 20_AI_Speculations?" },
        "call_clarify_1",
      ),
      contentOnlyResponse("20_AI_Speculations is your AI idea folder."),
    ]);
    setChatClientFactory(() => new LLMClient(AGENT_MODEL, chatStub));
    setProbeClientFactory(() => new LLMClient("probe-model", new StubLlmClient([toolCallResponse("ping", {})])));

    const asked: Array<Record<string, unknown>> = [];
    const response = await runChatQuery("update the manifest for the folders", async (args) => {
      asked.push({ question: args.question, deadline: args.deadline });
      return "AI speculation";
    });

    // The model's clarify question surfaced through the ask provider, and
    // the scripted answer resolved the run.
    expect(asked).toEqual([
      { question: "What is the purpose of the folder 20_AI_Speculations?", deadline: undefined },
    ]);
    expect(response.answer).toBe("20_AI_Speculations is your AI idea folder.");
    expect(response.results).toEqual([]);

    // The Q&A was recorded in the clarify conversation namespace.
    expect(filesIn(vault, CONVERSATION_DIRS.clarify)).toHaveLength(1);

    // The manifest task context (uncovered folders) was in the prompt.
    expect(chatStub.received[0][0].content).toContain("20_AI_Speculations");

    // The proposal reconciles the answer to the uncovered folder and leaves
    // the covered folder untouched.
    const proposal = response.clarifyProposal;
    expect(proposal).not.toBeUndefined();
    expect(proposal!.after).toContain("## 20_AI_Speculations/ <!-- AI speculation -->");
    expect(proposal!.after).toContain("## 10_Stocks/ <!-- stock research -->");
    expect(proposal!.unanswered).toEqual([]);

    // Idempotency: after the confirmed write, a re-run proposes nothing.
    writeClarifyProposal(vault, proposal!.manifestPath ?? "_manifest.md", proposal!);
    setChatClientFactory(() => new LLMClient(
      AGENT_MODEL,
      new StubLlmClient([
        toolCallResponse(
          "clarify",
          { question: "What is the purpose of the folder 20_AI_Speculations?" },
          "call_clarify_2",
        ),
        contentOnlyResponse("Done."),
      ]),
    ));
    const again = await runChatQuery("update the manifest for the folders", async () => "AI speculation");
    expect(again.clarifyProposal).toBeUndefined();
  });

  it("a declined answer surfaces the NO_ANSWER marker to the loop", async () => {
    const vault = makeVault({ "Inbox": ["i.md"] });
    writeManifest(vault, GENERATED_H1 + "\n");
    updateSettings({ vaultPath: vault });
    openChatSession(vault);

    const chatStub = new StubLlmClient([
      toolCallResponse("clarify", { question: "What is the purpose of the folder Inbox?", deadline: "2030-01-01T00:00:00Z" }),
      contentOnlyResponse("Left it uncovered."),
    ]);
    setChatClientFactory(() => new LLMClient(AGENT_MODEL, chatStub));
    setProbeClientFactory(() => new LLMClient("probe-model", new StubLlmClient([toolCallResponse("ping", {})])));

    const response = await runChatQuery("update the manifest for the folders", async () => null);
    expect(response.answer).toBe("Left it uncovered.");
    // No answer → nothing to reconcile → no proposal.
    expect(response.clarifyProposal).toBeUndefined();
  });

  it("a failed run clears partial-run leftovers — no stale sources under the error", async () => {
    const vault = makeVault({ "Inbox": ["i.md"] });
    writeManifest(vault, GENERATED_H1 + "\n");
    updateSettings({ vaultPath: vault });
    openChatSession(vault);

    // The model registers a citation first (cite_source), then the server
    // fails on a later turn — exactly the user's reported failure mode.
    const chatStub = new FailAfterLlmClient([
      toolCallResponse("cite_source", { source_id: 1 }),
    ]);
    setChatClientFactory(() => new LLMClient(AGENT_MODEL, chatStub));
    setProbeClientFactory(() => new LLMClient("probe-model", new StubLlmClient([toolCallResponse("ping", {})])));

    const response = await runChatQuery("explain the source", async () => null);
    expect(response.answer).toContain("Synthesis unavailable — LLM error: Malformed LLM response");
    // The error bubble must not render the failed run's citations/sources.
    expect(response.citationMap).toEqual({});
    expect(response.results).toEqual([]);
  });

  it("propose-and-confirm: the confirmed wording (last answer per folder) becomes the purpose", async () => {
    const vault = makeVault({ "99-assets": ["logo.png"] });
    writeManifest(vault, GENERATED_H1 + "\n");
    updateSettings({ vaultPath: vault });
    openChatSession(vault);

    const chatStub = new StubLlmClient([
      toolCallResponse(
        "clarify",
        { question: "What is the purpose of the folder 99-assets?" },
        "call_c1",
      ),
      toolCallResponse(
        "clarify",
        { question: "I propose 'To hold attachments and images.' for 99-assets — confirm or edit:" },
        "call_c2",
      ),
      contentOnlyResponse("Updated the manifest."),
    ]);
    setChatClientFactory(() => new LLMClient(AGENT_MODEL, chatStub));
    setProbeClientFactory(() => new LLMClient("probe-model", new StubLlmClient([toolCallResponse("ping", {})])));

    const answers: Record<string, string> = {
      "What is the purpose of the folder 99-assets?": "attachments and images",
      "I propose 'To hold attachments and images.' for 99-assets — confirm or edit:": "To hold attachments and images.",
    };
    const response = await runChatQuery("update the manifest for the folders", async (args) => {
      return answers[args.question] ?? null;
    });

    // The proposal uses the CONFIRMED wording, not the first raw answer.
    expect(response.clarifyProposal).not.toBeUndefined();
    expect(response.clarifyProposal!.after).toContain("## 99-assets/ <!-- To hold attachments and images. -->");
    expect(response.clarifyProposal!.after).not.toContain("attachments and images <!--");
  });

  it("an affirmative confirm ('yes') resolves the quoted proposal from the confirm question", async () => {
    const vault = makeVault({ "99-assets": ["logo.png"] });
    writeManifest(vault, GENERATED_H1 + "\n");
    updateSettings({ vaultPath: vault });
    openChatSession(vault);

    const chatStub = new StubLlmClient([
      toolCallResponse(
        "clarify",
        { question: "What is the purpose of the folder 99-assets?" },
        "call_c1",
      ),
      toolCallResponse(
        "clarify",
        { question: "Based on your answer, here's a concise purpose line for 99-assets: \"Attachments: images and non-Markdown files\". Does this wording work for you?" },
        "call_c2",
      ),
      contentOnlyResponse("Updated the manifest."),
    ]);
    setChatClientFactory(() => new LLMClient(AGENT_MODEL, chatStub));
    setProbeClientFactory(() => new LLMClient("probe-model", new StubLlmClient([toolCallResponse("ping", {})])));

    const answers: Record<string, string> = {
      "What is the purpose of the folder 99-assets?": "images and attachments",
      "Based on your answer, here's a concise purpose line for 99-assets: \"Attachments: images and non-Markdown files\". Does this wording work for you?": "yes",
    };
    const response = await runChatQuery("update the manifest for the folders", async (args) => {
      return answers[args.question] ?? null;
    });

    // The user's "yes" confirms the model's proposal — the QUOTED proposal
    // is written, never the bare confirmation.
    expect(response.clarifyProposal).not.toBeUndefined();
    expect(response.clarifyProposal!.after).toContain("## 99-assets/ <!-- Attachments: images and non-Markdown files -->");
    expect(response.clarifyProposal!.after).not.toContain("<!-- yes -->");
  });
});

describe("no-tool-call parity — deterministic dialog on the chat surface", () => {
  it("routes a manifest-review request through runClarifyDialog with the default questions", async () => {
    const vault = makeVault({ "Projects": ["p.md"], "Inbox": ["i.md"] });
    writeManifest(vault, GENERATED_H1 + "\n");
    updateSettings({ vaultPath: vault });
    openChatSession(vault);

    // The capability probe answers in text only → no_tool_calls.
    setProbeClientFactory(() => new LLMClient("probe-model", new StubLlmClient([contentOnlyResponse("pong")])));

    const asked: string[] = [];
    const response = await runChatQuery("update the manifest for the folders", async (args) => {
      asked.push(args.question);
      return args.question.includes("Inbox") ? "inbox" : "active work";
    });

    // The SAME deterministic questions as the module's default path.
    expect(asked).toEqual([
      'What is the purpose of the folder "Inbox"? Answer in a few words — this becomes the manifest purpose line.',
      'What is the purpose of the folder "Projects"? Answer in a few words — this becomes the manifest purpose line.',
    ]);
    expect(response.clarifyProposal).not.toBeUndefined();
    expect(response.clarifyProposal!.after).toContain("## Inbox/ <!-- inbox -->");
    expect(response.clarifyProposal!.after).toContain("## Projects/ <!-- active work -->");
    expect(response.answer).toContain("2 folders");
    // Q&A turns recorded in the clarify namespace.
    expect(filesIn(vault, CONVERSATION_DIRS.clarify)).toHaveLength(1);
  });

  it("does not run the dialog for a non-manifest question", async () => {
    const vault = makeVault({ "Inbox": ["i.md"] });
    writeManifest(vault, GENERATED_H1 + "\n");
    updateSettings({ vaultPath: vault });
    openChatSession(vault);
    setProbeClientFactory(() => new LLMClient("probe-model", new StubLlmClient([contentOnlyResponse("pong")])));

    const asked: string[] = [];
    // The ask provider must never fire for an ordinary query — the dialog
    // path is gated to manifest-review requests. (The plain fallback would
    // hit the embedding HTTP path, which cannot run under vitest — any
    // rejection proves the dialog did not run.)
    await expect(
      runChatQuery("hello there", async (args) => {
        asked.push(args.question);
        return "answer";
      }),
    ).rejects.toThrow();
    expect(asked).toEqual([]);
  });
});

describe("clarify turn extraction + gate", () => {
  it("extracts clarify tool-call pairs (question → answer) from a chat turn slice", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "c1",
          type: "function",
          function: { name: "clarify", arguments: JSON.stringify({ question: "Q1?" }) },
        }],
      },
      { role: "tool", tool_call_id: "c1", content: "A1" },
      { role: "assistant", content: "done" },
    ];
    expect(extractClarifyTurns(history)).toEqual([{ question: "Q1?", answer: "A1" }]);
  });

  it("ignores non-clarify tool calls", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "search_index", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "NO_RESULTS" },
      { role: "assistant", content: "ok" },
    ];
    expect(extractClarifyTurns(history)).toEqual([]);
  });

  it("skips pairs with malformed arguments", () => {
    const history: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "clarify", arguments: "not json" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "A1" },
      { role: "assistant", content: "done" },
    ];
    expect(extractClarifyTurns(history)).toEqual([]);
  });

  it("isManifestClarifyRequest gates manifest-review requests only", () => {
    expect(isManifestClarifyRequest("update the manifest for the folders")).toBe(true);
    expect(isManifestClarifyRequest("check _manifest coverage")).toBe(true);
    expect(isManifestClarifyRequest("summarize my notes on IREN")).toBe(false);
  });
});
