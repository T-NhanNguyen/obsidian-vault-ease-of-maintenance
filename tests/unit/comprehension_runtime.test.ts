// Comprehension runtime tests — the read-the-vault-like-a-book agent loop
// driven by a fake ILlmClient: the happy path to a confirmed run + summary
// card, the mandatory clarification on insufficient evidence (answer injected
// as a new user message), the budget-exhaustion flagged stop, and the
// no-vault guard.

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
import { closeChatSession, closeClarifySession } from "../../src/agent/chat_session";
import type { ClarifyArgs } from "../../src/agent/tools";

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const AGENT_MODEL = "comprehension-test-model";

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
