// Run-once comprehension + comprehend_vault tool tests (handoff Part A + B).
//
// Part A — runComprehension reuses a valid summary card instead of re-running
// the pipeline: a stub LLM asserts zero calls on the reuse path, a missing or
// flagged card triggers a fresh run, and the forced-refresh paths (per-call
// option and the config flag) bypass the reuse check.
//
// Part B — the comprehend_vault agent tool: returns the cached card text
// without an LLM call, runs the pipeline on the cold path, and is registered
// in the chat loop (behavioral) and the build/sort/cleanup loops (source
// wiring contract).

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { updateSettings, defaultSettings, type ComprehensionSettings } from "../../src/config";
import type { ChatResponse, ChatMessage, ChatTool, ILlmClient } from "../../src/agent/llm_client";
import type { HybridQueryDb } from "../../src/indexer/graph_search";
import type { SearchResult, SectionKeyRow } from "../../src/indexer/db_worker/types";
import {
  runComprehension,
  setComprehensionLlmFactory,
  resetComprehensionLlmFactory,
  setComprehensionVerifySeam,
  resetComprehensionVerifySeam,
} from "../../src/comprehension/runtime_comprehension";
import { buildSummaryCard, SummaryCardStore, isReusableCard, type SummaryCardData } from "../../src/comprehension/summary";
import { comprehendVault, buildComprehendVaultTool } from "../../src/agent/tools_comprehend";
import { detectToolCallSupport, setProbeClientFactory, resetCapabilityCache } from "../../src/agent/capability";
import { runChatQuery, setChatClientFactory, resetChatClientFactory } from "../../src/agent/runtime_chat";
import { LLMClient } from "../../src/agent/llm";
import { openChatSession, closeChatSession, closeClarifySession } from "../../src/agent/chat_session";

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const AGENT_MODEL = "runonce-test-model";

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
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-runonce-"));
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

function cardData(overrides: Partial<SummaryCardData> = {}): SummaryCardData {
  return {
    title: "test-vault",
    status: "confirmed",
    coverage: 0.9,
    toolCallsUsed: 42,
    verifyRounds: 2,
    topEntries: [],
    directorySummaries: [],
    synthesis: "The vault is a personal recipe collection.",
    flagged: false,
    generatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function writeCard(vault: string, overrides: Partial<SummaryCardData> = {}): string {
  const card = buildSummaryCard(cardData(overrides));
  new SummaryCardStore(vault).write(card);
  return card;
}

/** The scripted confirmed-run queue used whenever a fresh run must complete
 * (missing card, flagged card, forced refresh, tool cold path). */
function confirmedRunQueue(): ChatResponse[] {
  return [
    toolCallResponse("skim", {}),
    toolCallResponse("ledger_add", { assumption: "The vault is about cooking", score: 0.6 }),
    toolCallResponse("verify", { questions: ["What topics dominate?"] }),
    toolCallResponse("ledger_score", { id: "a1", adjustment: 0.3 }),
    contentOnlyResponse("The vault is a cooking recipe collection."),
  ];
}

function installVerifySeam(): void {
  setComprehensionVerifySeam({
    embedder: { embed: async () => [0.1], embedBatch: async () => [[0.1]] },
    db: new StubHybridDb([
      [{ score: 0.9, text: "Pasta techniques.", filePath: "a/one.md", headingPath: "One", lineStart: 1, lineEnd: 5 } as SearchResult],
    ]),
  });
}

const tempVaults: string[] = [];

beforeEach(() => {
  resetComprehensionLlmFactory();
  resetComprehensionVerifySeam();
  resetChatClientFactory();
  resetCapabilityCache();
  closeChatSession();
  closeClarifySession();
});

afterAll(() => {
  closeChatSession();
  closeClarifySession();
  setComprehensionLlmFactory(null);
  resetComprehensionVerifySeam();
  setProbeClientFactory(null);
  resetChatClientFactory();
  updateSettings(defaultSettings());
  for (const dir of tempVaults.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Part A — run-once comprehension
// ---------------------------------------------------------------------------

describe("runComprehension run-once reuse", () => {
  it("returns the valid summary card without running the pipeline (zero LLM calls, state untouched)", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\nContent." });
    tempVaults.push(vault);
    configure(vault);
    const written = writeCard(vault);

    const stub = new StubLlmClient([]);
    setComprehensionLlmFactory(() => stub);

    const response = await runComprehension("Understand this vault.");

    expect(stub.received).toHaveLength(0);
    expect(response.answer).toContain("The vault is a personal recipe collection.");
    expect(response.answer).toContain("reused from 2026-08-20T00:00:00.000Z");
    // No pipeline state was created or touched.
    expect(fs.existsSync(path.join(vault, ".note-maintainer/comprehension-state.json"))).toBe(false);
    expect(new SummaryCardStore(vault).read()).toBe(written);
  });

  it("runs the pipeline when no card exists", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    tempVaults.push(vault);
    configure(vault, { minCoverage: 0 });
    installVerifySeam();

    const stub = new StubLlmClient(confirmedRunQueue());
    setComprehensionLlmFactory(() => stub);

    const response = await runComprehension("Understand this vault.");

    expect(stub.received.length).toBeGreaterThan(0);
    expect(response.answer).toContain("The vault is a cooking recipe collection.");
    expect(response.answer).toContain("Vault summary card");
    expect(response.answer).not.toContain("reused");
  });

  it("runs the pipeline when the card is flagged", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    tempVaults.push(vault);
    configure(vault, { minCoverage: 0 });
    writeCard(vault, { status: "low_confidence", flagged: true });
    installVerifySeam();

    const stub = new StubLlmClient(confirmedRunQueue());
    setComprehensionLlmFactory(() => stub);

    const response = await runComprehension("Understand this vault.");

    expect(stub.received.length).toBeGreaterThan(0);
    expect(response.answer).toContain("The vault is a cooking recipe collection.");
    // The fresh run overwrote the flagged card with a confirmed one.
    const card = new SummaryCardStore(vault).read() ?? "";
    expect(card).toContain("flagged: false");
    expect(card).toContain("The vault is a cooking recipe collection.");
  });

  it("re-runs when forced per call, even with a valid card", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    tempVaults.push(vault);
    configure(vault, { minCoverage: 0 });
    writeCard(vault);
    installVerifySeam();

    const stub = new StubLlmClient(confirmedRunQueue());
    setComprehensionLlmFactory(() => stub);

    const response = await runComprehension("Understand this vault.", undefined, { forceRefresh: true });

    expect(stub.received.length).toBeGreaterThan(0);
    expect(response.answer).toContain("The vault is a cooking recipe collection.");
    expect(response.answer).not.toContain("reused");
  });

  it("re-runs when the config force_refresh flag is set, even with a valid card", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    tempVaults.push(vault);
    configure(vault, { minCoverage: 0, forceRefresh: true });
    writeCard(vault);
    installVerifySeam();

    const stub = new StubLlmClient(confirmedRunQueue());
    setComprehensionLlmFactory(() => stub);

    const response = await runComprehension("Understand this vault.");

    expect(stub.received.length).toBeGreaterThan(0);
    expect(response.answer).toContain("The vault is a cooking recipe collection.");
    expect(response.answer).not.toContain("reused");
  });

  it("an unparseable card (no frontmatter) is not reusable", () => {
    const vault = makeVault({ "a/one.md": "# One\n\nContent." });
    tempVaults.push(vault);
    new SummaryCardStore(vault).write("# No frontmatter here\n\nbody only");
    expect(isReusableCard(new SummaryCardStore(vault).readStructured())).toBe(false);
  });

  it("an unknown status in the card frontmatter is not reusable", () => {
    const vault = makeVault({ "a/one.md": "# One\n\nContent." });
    tempVaults.push(vault);
    writeCard(vault, { status: "nonsense_status" as SummaryCardData["status"], flagged: false });
    const structured = new SummaryCardStore(vault).readStructured();
    expect(structured?.status).toBeNull();
    expect(isReusableCard(structured)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Part B — comprehend_vault tool
// ---------------------------------------------------------------------------

describe("comprehend_vault tool", () => {
  it("is a Tool named comprehend_vault with an empty parameter schema", () => {
    const tool = buildComprehendVaultTool();
    expect(tool.name).toBe("comprehend_vault");
    expect(tool.toOpenAiTool().function.name).toBe("comprehend_vault");
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });

  it("returns the cached card text with zero LLM calls when a valid card exists", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\nContent." });
    tempVaults.push(vault);
    configure(vault);
    const written = writeCard(vault);

    const stub = new StubLlmClient([]);
    setComprehensionLlmFactory(() => stub);

    const result = await comprehendVault();

    expect(result).toBe(written);
    expect(stub.received).toHaveLength(0);
  });

  it("runs the comprehension pipeline on the cold path (no card) and returns the fresh synthesis", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    tempVaults.push(vault);
    configure(vault, { minCoverage: 0 });
    installVerifySeam();

    const stub = new StubLlmClient(confirmedRunQueue());
    setComprehensionLlmFactory(() => stub);

    const result = await comprehendVault();

    expect(stub.received.length).toBeGreaterThan(0);
    expect(result).toContain("The vault is a cooking recipe collection.");
    expect(result).toContain("Vault summary card");
    // The cold path wrote the durable card.
    expect(new SummaryCardStore(vault).exists()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part B — loop registration
// ---------------------------------------------------------------------------

describe("comprehend_vault loop registration", () => {
  it("is exposed in the chat loop's tool set", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\nContent." });
    tempVaults.push(vault);
    configure(vault);
    openChatSession(vault);

    const chatStub = new StubLlmClient([contentOnlyResponse("Hi there.")]);
    setChatClientFactory(() => new LLMClient(AGENT_MODEL, chatStub));
    setProbeClientFactory(() => new LLMClient("probe-model", new StubLlmClient([toolCallResponse("ping", {})])));

    const response = await runChatQuery("hello");

    expect(response.answer).toBe("Hi there.");
    expect(chatStub.toolSets[0]).toContain("comprehend_vault");
  });

  it("is wired into the build, sort, and cleanup runtime files", () => {
    const runtimeDir = path.resolve(process.cwd(), "src/agent");
    // The build registers the tool on its Stage 2 population LLM call,
    // which lives in manifest_populate.ts (runtime_build.ts itself makes no
    // LLM call anymore — handoff-2 pure skeleton).
    for (const file of ["manifest_populate.ts", "runtime_sort.ts", "runtime_cleanup.ts"]) {
      const source = fs.readFileSync(path.join(runtimeDir, file), "utf-8");
      expect(source).toContain('import { buildComprehendVaultTool } from "./tools_comprehend";');
      expect(source).toContain("buildComprehendVaultTool()");
    }
  });
});

