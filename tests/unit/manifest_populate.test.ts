// Manifest population tests (handoff-2 Stage 1 + 2) — the pure, headless
// build stages: the tree-to-skeleton writer (write-if-absent), the
// warm/cold comprehension plan, and the marker population pass (LLM seam +
// user ask channel + guarded write).

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { updateSettings, defaultSettings, type ComprehensionSettings } from "../../src/config";
import type { ChatResponse, ChatMessage, ChatTool, ILlmClient } from "../../src/agent/llm_client";
import { LLMClient } from "../../src/agent/llm";
import { buildSummaryCard, SummaryCardStore, type SummaryCardData } from "../../src/comprehension/summary";
import {
  writeSkeletonManifest,
  buildComprehensionPlan,
  populateManifestFromCard,
  parseLlmPurposes,
  setManifestPopulateLlmFactory,
  resetManifestPopulateLlmFactory,
} from "../../src/agent/manifest_populate";
import type { AskQuestion } from "../../src/agent/clarify";

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const AGENT_MODEL = "populate-test-model";

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

function contentOnlyResponse(content: string): ChatResponse {
  return { completionId: "c", role: "assistant", content, usage: USAGE };
}

function makeVault(files: Record<string, string>): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-populate-"));
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

const tempVaults: string[] = [];

beforeEach(() => {
  resetManifestPopulateLlmFactory();
  updateSettings(defaultSettings());
});

afterAll(() => {
  setManifestPopulateLlmFactory(null);
  for (const dir of tempVaults.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function installPopulateStub(response: string): StubLlmClient {
  const stub = new StubLlmClient([contentOnlyResponse(response)]);
  setManifestPopulateLlmFactory(() => new LLMClient(AGENT_MODEL, stub));
  return stub;
}

// ---------------------------------------------------------------------------
// Stage 1 — skeleton
// ---------------------------------------------------------------------------

describe("writeSkeletonManifest", () => {
  it("renders the tree with (needs review) markers at the correct depth", () => {
    const vault = makeVault({
      "a/one.md": "# One",
      "a/b/two.md": "# Two",
      "root.md": "# Root",
    });
    tempVaults.push(vault);
    configure(vault);

    const written = writeSkeletonManifest(vault);

    expect(written).toBe("_manifest.md");
    const content = fs.readFileSync(path.join(vault, "_manifest.md"), "utf-8");
    expect(content).toContain("# vault <!--");
    expect(content).toContain("## a/ <!-- (needs review) -->");
    expect(content).toContain("     one.md");
    expect(content).toContain("### a/b/ <!-- (needs review) -->");
    expect(content).toContain("     two.md");
    // Root files are not part of any folder entry.
    expect(content).not.toContain("root.md");
  });

  it("never overwrites an existing manifest", () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    fs.writeFileSync(path.join(vault, "_manifest.md"), "# vault\n\nuser content\n", "utf-8");

    const written = writeSkeletonManifest(vault);

    expect(written).toBeNull();
    expect(fs.readFileSync(path.join(vault, "_manifest.md"), "utf-8")).toBe(
      "# vault\n\nuser content\n",
    );
  });
});

// ---------------------------------------------------------------------------
// Stage 2 decision — warm/cold plan
// ---------------------------------------------------------------------------

describe("buildComprehensionPlan", () => {
  it("is cold when no card exists", () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    expect(buildComprehensionPlan(vault)).toBe("cold");
  });

  it("is warm when a valid card exists", () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    writeCard(vault);
    expect(buildComprehensionPlan(vault)).toBe("warm");
  });

  it("is cold when the card is flagged", () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    writeCard(vault, { status: "low_confidence", flagged: true });
    expect(buildComprehensionPlan(vault)).toBe("cold");
  });

  it("is cold when the config force_refresh flag is set", () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault, { forceRefresh: true });
    writeCard(vault);
    expect(buildComprehensionPlan(vault)).toBe("cold");
  });
});

// ---------------------------------------------------------------------------
// Stage 2 — population
// ---------------------------------------------------------------------------

describe("populateManifestFromCard", () => {
  it("replaces markers with LLM purposes and reports kept folders", async () => {
    const vault = makeVault({
      "recipes/one.md": "# One",
      "inbox/two.md": "# Two",
    });
    tempVaults.push(vault);
    configure(vault);
    writeCard(vault);
    writeSkeletonManifest(vault);
    installPopulateStub("recipes/ — cooking recipes and pasta\n");

    const result = await populateManifestFromCard(vault);

    expect(result.replaced).toBe(1);
    expect(result.kept).toEqual(["inbox"]);
    const content = fs.readFileSync(path.join(vault, "_manifest.md"), "utf-8");
    expect(content).toContain("## recipes/ <!-- cooking recipes and pasta -->");
    expect(content).toContain("## inbox/ <!-- (needs review) -->");
  });

  it("uses the ask channel for folders the LLM pass could not describe", async () => {
    const vault = makeVault({
      "recipes/one.md": "# One",
      "inbox/two.md": "# Two",
    });
    tempVaults.push(vault);
    configure(vault);
    writeCard(vault);
    writeSkeletonManifest(vault);
    installPopulateStub("recipes/ — cooking recipes\n");

    const asked: string[] = [];
    const ask: AskQuestion = async (question) => {
      asked.push(question.folderPath);
      return "random notes and links";
    };
    const result = await populateManifestFromCard(vault, ask);

    expect(asked).toEqual(["inbox"]);
    expect(result.replaced).toBe(2);
    const content = fs.readFileSync(path.join(vault, "_manifest.md"), "utf-8");
    expect(content).toContain("## inbox/ <!-- random notes and links -->");
  });

  it("keeps the marker when the user declines to answer", async () => {
    const vault = makeVault({ "inbox/two.md": "# Two" });
    tempVaults.push(vault);
    configure(vault);
    writeCard(vault);
    writeSkeletonManifest(vault);
    installPopulateStub("");

    const ask: AskQuestion = async () => null;
    const result = await populateManifestFromCard(vault, ask);

    expect(result.replaced).toBe(0);
    expect(result.kept).toEqual(["inbox"]);
    const content = fs.readFileSync(path.join(vault, "_manifest.md"), "utf-8");
    expect(content).toContain("<!-- (needs review) -->");
  });

  it("makes zero LLM calls when the manifest has no markers", async () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    writeCard(vault);
    fs.writeFileSync(path.join(vault, "_manifest.md"), "# vault\n\n## a/ <!-- hand written -->\n", "utf-8");
    const stub = installPopulateStub("a/ — nonsense");

    const result = await populateManifestFromCard(vault);

    expect(stub.received).toHaveLength(0);
    expect(result.replaced).toBe(0);
    expect(fs.readFileSync(path.join(vault, "_manifest.md"), "utf-8")).toContain("hand written");
  });

  it("is a no-op when no manifest exists", async () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    writeCard(vault);
    const stub = installPopulateStub("a/ — x");

    const result = await populateManifestFromCard(vault);

    expect(stub.received).toHaveLength(0);
    expect(result).toEqual({ replaced: 0, kept: [] });
  });
});

// ---------------------------------------------------------------------------
// parseLlmPurposes
// ---------------------------------------------------------------------------

describe("parseLlmPurposes", () => {
  it("maps folder lines onto known folders and drops unknown tokens", () => {
    const known = new Set(["a", "a/b"]);
    const parsed = parseLlmPurposes(
      "- a/ — recipes\n- a/b — nested notes\n- missing/ — not a folder\n",
      known,
    );
    expect(parsed).toEqual({ a: "recipes", "a/b": "nested notes" });
  });

  it("drops empty, bracketed, and overlong purposes", () => {
    const known = new Set(["a"]);
    expect(parseLlmPurposes("a/ —\n", known)).toEqual({});
    expect(parseLlmPurposes("a/ — [tbd]\n", known)).toEqual({});
    expect(parseLlmPurposes(`a/ — ${"x".repeat(201)}\n`, known)).toEqual({});
  });
});
