// Build-flow tests (handoff-2) — the orchestrator stages in their run order:
// prepareBuild writes the skeleton before any build, the warm/cold plan
// branches, and the cold stage runs the comprehension loop once followed by
// the population pass. The warm path asserts zero LLM calls on both seams.
// The index build itself (runBuildIndex) needs a real sql.js wasm, so it is
// covered structurally: prepareBuild and the stage functions it orders are
// tested here, and getCommunitySeeds proves the populated manifest maps the
// communities (AC5) without a database.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { updateSettings, defaultSettings, type ComprehensionSettings } from "../../src/config";
import type { ChatResponse, ChatMessage, ChatTool, ILlmClient } from "../../src/agent/llm_client";
import type { HybridQueryDb } from "../../src/indexer/graph_search";
import type { SearchResult, SectionKeyRow } from "../../src/indexer/db_worker/types";
import { LLMClient } from "../../src/agent/llm";
import { buildSummaryCard, SummaryCardStore, type SummaryCardData } from "../../src/comprehension/summary";
import {
  prepareBuild,
  runComprehensionBuildStage,
} from "../../src/agent/runtime_build";
import {
  DEFAULT_COMPREHENSION_QUESTION,
  setComprehensionLlmFactory,
  resetComprehensionLlmFactory,
  setComprehensionVerifySeam,
  resetComprehensionVerifySeam,
} from "../../src/comprehension/runtime_comprehension";
import {
  setManifestPopulateLlmFactory,
  resetManifestPopulateLlmFactory,
} from "../../src/agent/manifest_populate";
import { ManifestParser } from "../../src/indexer/manifest";

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const AGENT_MODEL = "buildflow-test-model";

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

function makeVault(files: Record<string, string>): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-buildflow-"));
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

function writeCard(vault: string, overrides: Partial<SummaryCardData> = {}): string {
  const card = buildSummaryCard({
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
  });
  new SummaryCardStore(vault).write(card);
  return card;
}

/** The scripted confirmed-run queue — the comprehension loop must complete. */
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

const tempVaults: string[] = [];

beforeEach(() => {
  resetComprehensionLlmFactory();
  resetComprehensionVerifySeam();
  resetManifestPopulateLlmFactory();
  updateSettings(defaultSettings());
});

afterAll(() => {
  setComprehensionLlmFactory(null);
  resetComprehensionVerifySeam();
  setManifestPopulateLlmFactory(null);
  for (const dir of tempVaults.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// prepareBuild — Stage 1 + plan, before any index build
// ---------------------------------------------------------------------------

describe("prepareBuild", () => {
  it("writes the skeleton manifest before returning (AC1 sequence)", async () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);

    const { plan } = await prepareBuild(vault);

    const manifestPath = path.join(vault, "_manifest.md");
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.readFileSync(manifestPath, "utf-8")).toContain("<!-- (needs review) -->");
    expect(plan).toBe("cold");
  });

  it("leaves an existing user-edited manifest untouched (AC6)", async () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    const userManifest = "# vault\n\n## a/ <!-- hand written purpose -->\n";
    fs.writeFileSync(path.join(vault, "_manifest.md"), userManifest, "utf-8");

    await prepareBuild(vault);

    expect(fs.readFileSync(path.join(vault, "_manifest.md"), "utf-8")).toBe(userManifest);
  });

  it("plans warm when a valid card exists and touches no LLM seam (AC3)", async () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    writeCard(vault);
    const compStub = new StubLlmClient([]);
    const popStub = new StubLlmClient([]);
    setComprehensionLlmFactory(() => compStub);
    setManifestPopulateLlmFactory(() => new LLMClient(AGENT_MODEL, popStub));

    const { plan } = await prepareBuild(vault);

    expect(plan).toBe("warm");
    expect(compStub.received).toHaveLength(0);
    expect(popStub.received).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runComprehensionBuildStage — Stage 2 cold path
// ---------------------------------------------------------------------------

describe("runComprehensionBuildStage", () => {
  it("runs the comprehension loop once, then populates the manifest (AC2, AC4)", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    tempVaults.push(vault);
    configure(vault, { minCoverage: 0 });
    installVerifySeam();
    // The flow runs Stage 1 (skeleton) before the cold stage.
    await prepareBuild(vault);

    const compStub = new StubLlmClient(confirmedRunQueue());
    setComprehensionLlmFactory(() => compStub);
    const popStub = new StubLlmClient([contentOnlyResponse("a/ — cooking recipes\n")]);
    setManifestPopulateLlmFactory(() => new LLMClient(AGENT_MODEL, popStub));

    const response = await runComprehensionBuildStage(vault, DEFAULT_COMPREHENSION_QUESTION);

    // The loop ran exactly once (its tool loop drives several stub calls).
    expect(compStub.received.length).toBeGreaterThan(0);
    expect(response.answer).toContain("The vault is a cooking recipe collection.");
    // The fresh card was written.
    expect(new SummaryCardStore(vault).read() ?? "").toContain("status: confirmed");
    // The manifest markers were replaced by the population pass.
    const manifest = fs.readFileSync(path.join(vault, "_manifest.md"), "utf-8");
    expect(manifest).toContain("## a/ <!-- cooking recipes -->");
    expect(manifest).not.toContain("(needs review)");
  });
});

// ---------------------------------------------------------------------------
// AC5 — the populated manifest maps the communities from purposes
// ---------------------------------------------------------------------------

describe("getCommunitySeeds after population", () => {
  it("reads the purpose text, not the stub marker", async () => {
    const vault = makeVault({ "a/one.md": "# One", "b/two.md": "# Two" });
    tempVaults.push(vault);
    configure(vault);
    writeCard(vault);
    fs.writeFileSync(
      path.join(vault, "_manifest.md"),
      "# vault\n\n## a/ <!-- cooking recipes -->\n\n## b/ <!-- (needs review) -->\n",
      "utf-8",
    );

    const seeds = new ManifestParser(vault).getCommunitySeeds();

    const seedA = seeds.find((s) => s.folderPath === "a");
    expect(seedA?.seedText).toBe("a: cooking recipes");
    const seedB = seeds.find((s) => s.folderPath === "b");
    // The marker stays in the manifest for an undescribed folder — the seed
    // carries it (today's status quo; a populated purpose seeds properly).
    expect(seedB?.seedText).toBe("b: (needs review)");
  });
});
