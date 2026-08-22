// Comprehension runtime tests — the read-the-vault-like-a-book agent loop
// driven by a fake ILlmClient: the happy path to a confirmed run + summary
// card, the mandatory clarification on insufficient evidence (answer injected
// as a new user message), the budget-exhaustion flagged stop, and the
// no-vault guard.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { updateSettings, defaultSettings, settings, type ComprehensionSettings } from "../../src/config";
import type { ChatResponse, ChatMessage, ChatTool, ILlmClient } from "../../src/agent/llm_client";
import type { HybridQueryDb } from "../../src/indexer/graph_search";
import type { SearchResult, SectionKeyRow } from "../../src/indexer/db_worker/types";
import {
  runComprehension,
  compactConversation,
  isComprehensionRequest,
  DEFAULT_COMPREHENSION_QUESTION,
  setComprehensionLlmFactory,
  resetComprehensionLlmFactory,
  setComprehensionVerifySeam,
  resetComprehensionVerifySeam,
} from "../../src/comprehension/runtime_comprehension";
import { closeChatSession, closeClarifySession } from "../../src/agent/chat_session";
import type { ClarifyArgs } from "../../src/agent/tools";

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const AGENT_MODEL = "comprehension-test-model";

class StubLlmClient implements ILlmClient {
  private queue: ChatResponse[];
  readonly received: ChatMessage[][] = [];
  readonly toolSets: string[][] = [];

  constructor(queue: ChatResponse[]) {
    this.queue = [...queue];
  }

  async chatCompletion(
    _model: string,
    messages: ChatMessage[],
    tools?: ChatTool[] | null,
  ): Promise<ChatResponse> {
    this.received.push(messages);
    this.toolSets.push((tools ?? []).map((t) => t.function.name).sort());
    const next = this.queue.shift();
    if (!next) throw new Error("StubLlmClient: response queue exhausted");
    return next!;
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

/** Stub HybridQueryDb with scripted cosine hits (hybridQuery short-circuits
 * to the cosine tier when the graph is empty). */
class StubHybridDb implements HybridQueryDb {
  private call = 0;
  constructor(private hitsByCall: SearchResult[][]) {}

  async searchSimilar(): Promise<SearchResult[]> {
    return this.hitsByCall[this.call++] ?? [];
  }
  async getSectionKeys(): Promise<SectionKeyRow[]> {
    return [{ node_key: "a/one.md::Intro", file_id: "a/one.md", heading_path: "Intro", heading_text: "Intro" }];
  }
  async getAllEntities() {
    return [];
  }
  async getSectionsForEntities() {
    return [];
  }
  async getWikilinkEdges() {
    return [];
  }
  async getSemanticEdges() {
    return [];
  }
  async getSectionsByKeys() {
    return [];
  }
}

function makeVault(files: Record<string, string>): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-comprehension-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(vault, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
  }
  return vault;
}

function configure(vault: string, overrides: Partial<ComprehensionSettings> = {}): void {
  updateSettings({
    vaultPath: vault,
    ignorePatterns: "",
    dbPath: path.join(vault, ".note-maintainer/index.db"),
    api: { baseUrl: "http://localhost:9999/v1", apiKey: "test-key" },
    embedding: { model: "test", dimensions: 8 },
    agent: { model: AGENT_MODEL, thinking: { chat: false, build: false, sort: false } },
    comprehension: { ...defaultSettings().comprehension, ...overrides },
  });
}

const tempVaults: string[] = [];

beforeEach(() => {
  resetComprehensionLlmFactory();
  resetComprehensionVerifySeam();
  closeChatSession();
  closeClarifySession();
});

afterAll(() => {
  closeChatSession();
  closeClarifySession();
  setComprehensionLlmFactory(null);
  resetComprehensionVerifySeam();
  updateSettings(defaultSettings());
  for (const dir of tempVaults.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runComprehension", () => {
  it("drives a confirmed run to a durable summary card", async () => {
    const vault = makeVault({
      "README.md": "# README\n\nThe vault documents cooking recipes.",
      "a/one.md": "# One\n\nPasta techniques.",
      "a/two.md": "# Two\n\nSauces and broths.",
      "b/three.md": "# Three\n\nDesserts.",
    });
    tempVaults.push(vault);
    configure(vault);
    setComprehensionVerifySeam({
      embedder: { embed: async () => [0.1], embedBatch: async () => [[0.1]] },
      db: new StubHybridDb([
        [{ score: 0.9, text: "Pasta techniques.", filePath: "a/one.md", headingPath: "One", lineStart: 1, lineEnd: 5 } as SearchResult],
      ]),
    });

    const queue = [
      toolCallResponse("skim", {}),
      toolCallResponse("ledger_add", { assumption: "The vault is about cooking", score: 0.6 }),
      toolCallResponse("verify", { questions: ["What topics dominate?", "What is the vault about?"] }),
      toolCallResponse("ledger_score", { id: "a1", adjustment: 0.3 }),
      contentOnlyResponse("The vault is a cooking recipe collection."),
    ];
    setComprehensionLlmFactory(() => new StubLlmClient(queue));

    const response = await runComprehension("Understand this vault.");
    expect(response.answer).toContain("The vault is a cooking recipe collection.");
    expect(response.answer).toContain("Vault summary card");
    expect(response.answer).toContain("confirmed");

    // Durable artifacts under .note-maintainer/.
    const card = fs.readFileSync(path.join(vault, ".note-maintainer/vault-summary.md"), "utf-8");
    expect(card).toContain("status: confirmed");
    expect(card).toContain("flagged: false");
    expect(card).toContain("The vault is a cooking recipe collection.");
    const ledger = JSON.parse(
      fs.readFileSync(path.join(vault, ".note-maintainer/comprehension-ledger.json"), "utf-8"),
    ) as { entries: Array<{ id: string; score: number; assumption: string }> };
    expect(ledger.entries[0]).toMatchObject({ id: "a1", score: 0.9, assumption: "The vault is about cooking" });
    const state = JSON.parse(
      fs.readFileSync(path.join(vault, ".note-maintainer/comprehension-state.json"), "utf-8"),
    ) as { phase: string; status: string; complete: boolean };
    expect(state).toMatchObject({ phase: "summarize", status: "confirmed", complete: true });
  });

  it("fires a mandatory clarification on insufficient evidence when the model tries to conclude, and injects the answer", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\nContent." });
    tempVaults.push(vault);
    configure(vault);
    setComprehensionVerifySeam({
      embedder: { embed: async () => [0.1], embedBatch: async () => [[0.1]] },
      db: new StubHybridDb([
        [{ score: 0.8, text: "Content.", filePath: "a/one.md", headingPath: "One", lineStart: 1, lineEnd: 5 } as SearchResult],
      ]),
    });

    const asked: ClarifyArgs[] = [];
    const ask = async (args: ClarifyArgs): Promise<string> => {
      asked.push(args);
      return "It's about cooking.";
    };

    const queue = [
      toolCallResponse("ledger_add", { assumption: "The vault is about food", score: 0.5 }),
      contentOnlyResponse("The vault is about food."), // model tries to conclude with coverage 0 → mandatory clarify
      toolCallResponse("skim", {}),
      toolCallResponse("verify", { questions: ["What is the vault about?"] }),
      toolCallResponse("ledger_score", { id: "a1", adjustment: 0.3 }),
      contentOnlyResponse("The vault is about cooking."),
    ];
    const stub = new StubLlmClient(queue);
    setComprehensionLlmFactory(() => stub);

    const response = await runComprehension("Understand this vault.", ask);
    expect(asked).toHaveLength(1);
    expect(asked[0].question).toContain("insufficient evidence");
    // The answer was injected as a new user message after the model's stop.
    const injected = stub.received.some((messages) =>
      messages.some((m) => m.role === "user" && (m.content ?? "").includes("It's about cooking.")),
    );
    expect(injected).toBe(true);
    expect(response.answer).toContain("The vault is about cooking.");
    expect(response.answer).toContain("confirmed");
  });

  it("stops flagged when the tool-call budget is exhausted without confirmation", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\nContent." });
    tempVaults.push(vault);
    configure(vault, { toolCallBudget: 3 });
    setComprehensionVerifySeam({
      embedder: { embed: async () => [0.1], embedBatch: async () => [[0.1]] },
      db: new StubHybridDb([]),
    });

    const queue = [
      toolCallResponse("ledger_status", {}),
      toolCallResponse("ledger_status", {}),
      toolCallResponse("ledger_status", {}),
      contentOnlyResponse("The vault could not be understood."),
    ];
    setComprehensionLlmFactory(() => new StubLlmClient(queue));

    const response = await runComprehension("Understand this vault.");
    expect(response.answer).toContain("flagged");
    const card = fs.readFileSync(path.join(vault, ".note-maintainer/vault-summary.md"), "utf-8");
    expect(card).toContain("flagged: true");
    expect(card).toContain("status: insufficient_evidence");
  });

  it("returns a guard message when no vault is open", async () => {
    updateSettings({ vaultPath: "" });
    const response = await runComprehension("Understand this vault.");
    expect(response.answer).toContain("No vault open");
  });
});

// ---------------------------------------------------------------------------
// Revision R2 — bounded-context comprehension (R2.1–R2.7 specs + R2.8 tests)
// ---------------------------------------------------------------------------

describe("R2 bounded-context comprehension", () => {
  it("sends the STATE card with status/coverage/folders/ledger/synthesis", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    configure(vault, { minCoverage: 0 });
    const stub = new StubLlmClient([
      toolCallResponse("skim", {}),
      toolCallResponse("ledger_add", { assumption: "The vault is about cooking", score: 0.6 }),
      contentOnlyResponse("The vault is about cooking."),
      contentOnlyResponse("The vault is about cooking."),
    ]);
    setComprehensionLlmFactory(() => stub);

    await runComprehension("Understand this vault.");

    const cards = stub.received.flatMap((msgs) =>
      msgs.filter((m) => m.role === "system" && (m.content ?? "").startsWith("STATE card")),
    );
    expect(cards.length).toBeGreaterThan(0);
    const card = cards[cards.length - 1].content ?? "";
    expect(card).toContain("- status:");
    expect(card).toContain("- coverage:");
    expect(card).toContain("- folders:");
    expect(card).toContain("- ledger:");
    expect(card).toContain("- synthesis:");
  });

  it("compacts a long conversation to system + card + last 2 turns + last 2 skim results", () => {
    const system = { role: "system" as const, content: "system prompt" };
    const card = { role: "system" as const, content: "STATE card\n- status: x" };
    const user = { role: "user" as const, content: "Understand this vault." };
    const asst1 = { role: "assistant" as const, content: "a1", tool_calls: [] };
    const tool1 = { role: "tool" as const, tool_call_id: "t1", content: "# v — 1 files, 1 folders, ~5 words total\n## a/one.md | root | 5w | - | body" };
    const asst2 = { role: "assistant" as const, content: "a2", tool_calls: [] };
    const tool2 = { role: "tool" as const, tool_call_id: "t2", content: "# v — 1 files, 1 folders, ~7 words total\n## b/two.md | regular | 7w | - | body" };
    const asst3 = { role: "assistant" as const, content: "a3", tool_calls: [] };
    const tool3 = { role: "tool" as const, tool_call_id: "t3", content: "# v — 1 files, 1 folders, ~9 words total\n## c/three.md | regular | 9w | - | body" };
    const asst4 = { role: "assistant" as const, content: "a4 final", tool_calls: [] };
    const messages: ChatMessage[] = [system, card, user, asst1, tool1, asst2, tool2, asst3, tool3, asst4, card];

    compactConversation(messages, 10);

    expect(messages[0].content).toBe("system prompt");
    const contents = messages.map((m) =>
      m.role === "system" ? (m.content ?? "") : m.role === "tool" ? (m.content ?? "") : `[${m.role}]`,
    );
    expect(contents.some((c) => c.startsWith("STATE card"))).toBe(true);
    expect(contents.some((c) => c.includes("## c/three.md"))).toBe(true);
    expect(contents.some((c) => c.includes("## b/two.md"))).toBe(true);
    expect(messages.some((m) => m.role === "user")).toBe(false);
    expect(messages.some((m) => m.role === "assistant" && m.content === "a1")).toBe(false);
    expect(messages.some((m) => m.role === "assistant" && m.content === "a4 final")).toBe(true);
  });

  it("leaves a short conversation untouched", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "short" },
    ];
    compactConversation(messages, 100);
    expect(messages).toHaveLength(2);
  });

  it("scopes tools by phase: explore in cover/texture, verify set after the verify call", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    configure(vault, { sampleTargetFiles: 2, minCoverage: 0 });
    setComprehensionVerifySeam({
      embedder: { embed: async () => [0.1], embedBatch: async () => [[0.1]] },
      db: new StubHybridDb([
        [{ score: 0.8, text: "Content.", filePath: "a/one.md", headingPath: "One", lineStart: 1, lineEnd: 5 } as SearchResult],
      ]),
    });
    const stub = new StubLlmClient([
      toolCallResponse("skim", {}),
      toolCallResponse("ledger_add", { assumption: "The vault is about cooking", score: 0.6 }),
      toolCallResponse("verify", { questions: ["What topics dominate?"] }),
      toolCallResponse("ledger_score", { id: "a1", adjustment: 0.3 }),
      contentOnlyResponse("The vault is a cooking recipe collection."),
    ]);
    setComprehensionLlmFactory(() => stub);

    await runComprehension("Understand this vault.");

    const explore = ["ledger_add", "ledger_delete", "ledger_print", "ledger_score", "ledger_status", "note", "skim"].sort();
    const verifySet = ["ledger_print", "ledger_score", "ledger_status", "verify"].sort();
    expect(stub.toolSets[0]).toEqual(explore);
    expect(stub.toolSets[1]).toEqual(explore);
    expect(stub.toolSets[2]).toEqual(explore);
    expect(stub.toolSets[3]).toEqual(verifySet);
    expect(stub.toolSets[3]).not.toContain("skim");
    expect(stub.toolSets[3]).not.toContain("clarify");
  });

  it("exposes only clarify + ledger_status while a clarification is pending", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\nContent." });
    configure(vault); // default minCoverage 0.6 with coverage 0 → insufficient evidence
    const stub = new StubLlmClient([
      contentOnlyResponse("The vault is about food."),
      contentOnlyResponse("The vault is about food."),
      contentOnlyResponse("The vault is about food."),
    ]);
    setComprehensionLlmFactory(() => stub);

    await runComprehension("Understand this vault.");

    expect(stub.toolSets[1]).toEqual(["clarify", "ledger_status"].sort());
    expect(stub.toolSets[1]).not.toContain("skim");
    expect(stub.toolSets[1]).not.toContain("ledger_add");
  });

  it("note tool returns a bounded view and rejects traversal", async () => {
    const longBody = "word ".repeat(500) + "\n\n## Heading Two\n\nmore words here.";
    const vault = makeVault({
      "a/one.md": "---\ntags: [architecture, design]\n---\n# Architect Design\n\n" + longBody,
    });
    configure(vault, { minCoverage: 0 });
    const stub = new StubLlmClient([
      toolCallResponse("note", { path: "a/one.md" }),
      toolCallResponse("note", { path: "../../etc/passwd" }),
      toolCallResponse("note", { path: "/etc/passwd" }),
      contentOnlyResponse("The vault is a test vault."),
    ]);
    setComprehensionLlmFactory(() => stub);

    await runComprehension("Understand this vault.");

    const results = stub.received
      .flatMap((msgs) => msgs.filter((m) => m.role === "tool"))
      .map((m) => m.content ?? "");
    const ok = results.find((r) => r.startsWith("path: a/one.md"));
    expect(ok).toBeDefined();
    expect(ok).toContain("tags: [architecture, design]");
    expect(ok).toContain("- # Architect Design");
    const body = (ok ?? "").split("body (first 200 words):")[1] ?? "";
    expect(body.trim().split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(200);
    expect(results.some((r) => r.startsWith("Error:") && r.includes("parent traversal"))).toBe(true);
    expect(results.some((r) => r.startsWith("Error:") && r.includes("absolute path"))).toBe(true);
  });

  it("coverage counts every folder in directories, sampled or not (R2.2)", async () => {
    const files: Record<string, string> = { "00-home.md": "# Home\n\n" + "w ".repeat(20) };
    for (const f of ["0f1", "0f2", "0f3", "0f4", "0f5"]) {
      for (let i = 1; i <= 3; i++) files[`${f}/${f}-${i}.md`] = `# ${f} ${i}\n\n` + "w ".repeat(20);
    }
    const vault = makeVault(files);
    configure(vault, { sampleTargetFiles: 1, minCoverage: 0 });
    setComprehensionVerifySeam({
      embedder: { embed: async () => [0.1], embedBatch: async () => [[0.1]] },
      db: new StubHybridDb([
        [{ score: 0.8, text: "Content.", filePath: "0f1/0f1-1.md", headingPath: "One", lineStart: 1, lineEnd: 5 } as SearchResult],
      ]),
    });
    const stub = new StubLlmClient([
      toolCallResponse("skim", {}),
      toolCallResponse("ledger_add", { assumption: "The vault is a test fixture", score: 0.6 }),
      toolCallResponse("verify", { questions: ["What is the vault about?"] }),
      toolCallResponse("ledger_score", { id: "a1", adjustment: 0.3 }),
      contentOnlyResponse("The vault is a test fixture."),
    ]);
    setComprehensionLlmFactory(() => stub);

    const response = await runComprehension("Understand this vault.");
    const state = JSON.parse(
      fs.readFileSync(path.join(vault, ".note-maintainer/comprehension-state.json"), "utf-8"),
    ) as { coverage: number };

    // Root "" + one sampled subfolder over six folders → 2/6; the four
    // unsampled subfolders still count in the denominator.
    expect(state.coverage).toBeCloseTo(2 / 6, 6);
    expect(response.answer).toContain("Vault summary card");
  });

  it("updateSettings skips undefined keys, keeping defaults and applying overrides (R2.7)", () => {
    updateSettings(defaultSettings());
    const partial = {
      confirmThreshold: undefined,
      softThreshold: undefined,
      hotTopics: ["x"],
    } as unknown as ComprehensionSettings;
    updateSettings({ comprehension: partial });

    expect(settings.comprehension.confirmThreshold).toBe(0.8);
    expect(settings.comprehension.softThreshold).toBe(0.7);
    expect(settings.comprehension.hotTopics).toEqual(["x"]);
  });

  it("a stale incomplete state does not leak phase/coverage/counters into a new invocation", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    configure(vault, { minCoverage: 0.6, sampleTargetFiles: 2 });

    // Simulate a previous incomplete run: verify phase, low coverage, burned
    // budget — the exact shape that locked the observed run out of `skim`.
    const io = new (await import("../../src/io/vault_io")).VaultIO(vault);
    io.writeTextAtomic(
      ".note-maintainer/comprehension-state.json",
      JSON.stringify({
        phase: "verify",
        status: "insufficient_evidence",
        statusReason: "Sampled coverage (0.17) is below the minimum (0.6).",
        toolCallsUsed: 28,
        toolCallBudget: 60,
        verifyRounds: 3,
        coverage: 0.16666666666666666,
        hotTopicsHit: [],
        lastRunAt: null,
        complete: false,
      }),
    );

    const stub = new StubLlmClient([
      toolCallResponse("skim", {}),
      contentOnlyResponse("The vault is about cooking."),
    ]);
    setComprehensionLlmFactory(() => stub);

    await runComprehension("Understand this vault.");

    const state = JSON.parse(
      fs.readFileSync(path.join(vault, ".note-maintainer/comprehension-state.json"), "utf-8"),
    ) as { phase: string; coverage: number; toolCallsUsed: number };

    // Fresh pass: the first request exposes the explore set (incl. skim), the
    // counters are zeroed, and coverage reflects the fresh scan, not 0.17.
    expect(stub.toolSets[0]).toContain("skim");
    expect(state.toolCallsUsed).toBeLessThan(2);
    expect(state.coverage).toBeGreaterThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// Chat routing — the comprehension pipeline must run ONLY for the explicit
// "understand the vault" request; every other chat prompt (e.g. "hello")
// must go to plain RAG chat instead of re-running the whole protocol.
// ---------------------------------------------------------------------------

describe("isComprehensionRequest routing", () => {
  it("matches the command's auto-submitted question", () => {
    expect(isComprehensionRequest(DEFAULT_COMPREHENSION_QUESTION)).toBe(true);
  });

  it("matches case-insensitively with surrounding whitespace", () => {
    expect(isComprehensionRequest("  understand THIS vault.  ")).toBe(true);
  });

  it("rejects ordinary chat prompts", () => {
    expect(isComprehensionRequest("hello")).toBe(false);
    expect(isComprehensionRequest("What is the vault about?")).toBe(false);
    expect(isComprehensionRequest("")).toBe(false);
    expect(isComprehensionRequest("Update the manifest")).toBe(false);
  });
});
