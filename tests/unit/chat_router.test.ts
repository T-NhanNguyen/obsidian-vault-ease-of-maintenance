// Router tests — the single intent-aware chat router with the semaphore.
// Pins the routing rules (build stage / comprehension / regular chat) and
// the lock contract (busy answer while held, zero LLM calls, release in
// finally). Factory seams drive every LLM boundary: the chat client, the
// comprehension client, the manifest-population client, and a stubbed index
// build (no sql.js wasm needed).

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { updateSettings, defaultSettings, type ComprehensionSettings } from "../../src/config";
import type { ChatResponse, ChatMessage, ChatTool, ILlmClient } from "../../src/agent/llm_client";
import type { HybridQueryDb } from "../../src/indexer/graph_search";
import type { SearchResult, SectionKeyRow } from "../../src/indexer/db_worker/types";
import { LLMClient } from "../../src/agent/llm";
import { runChatRouter, chatBusyMessage } from "../../src/chat_router";
import {
  acquireChatLock,
  releaseChatLock,
  chatLockHolder,
} from "../../src/chat_gate";
import {
  setChatClientFactory,
  resetChatClientFactory,
} from "../../src/agent/runtime_chat";
import {
  setProbeClientFactory,
  resetCapabilityCache,
} from "../../src/agent/capability";
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
import {
  prepareBuild,
  setBuildIndexSeam,
  resetBuildIndexSeam,
} from "../../src/agent/runtime_build";
import {
  openChatSession,
  closeChatSession,
  closeClarifySession,
} from "../../src/agent/chat_session";

const USAGE = { promptTokens: 1, completionTokens: 1, totalTokens: 2 };
const AGENT_MODEL = "chat-router-model";

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

function makeVault(files: Record<string, string>): string {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-chat-router-"));
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

/** An EMPTY index — comprehension runs before any index exists on the cold
 * build; verify reports index "missing" and the run confirms on skim. */
class StubMissingIndexDb implements HybridQueryDb {
  async searchSimilar(): Promise<SearchResult[]> {
    return [];
  }
  async getSectionKeys(): Promise<SectionKeyRow[]> {
    return [];
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

function installVerifySeam(): void {
  setComprehensionVerifySeam({
    embedder: { embed: async () => [0.1], embedBatch: async () => [[0.1]] },
    db: new StubMissingIndexDb(),
  });
}

/** The scripted cold-run queue for a missing-index comprehension pass. */
function coldRunQueue(): ChatResponse[] {
  return [
    toolCallResponse("skim", {}),
    toolCallResponse("ledger_add", { assumption: "The vault is about cooking", score: 0.6 }),
    toolCallResponse("verify", { questions: ["What topics dominate?"] }),
    contentOnlyResponse("The vault is a cooking recipe collection."),
  ];
}

/** Wires every seam needed for a chat-path run (agentic loop through the
 * chat client stub). */
function installChatSeam(answer: string): StubLlmClient {
  const chatStub = new StubLlmClient([contentOnlyResponse(answer)]);
  setChatClientFactory(() => new LLMClient(AGENT_MODEL, chatStub));
  setProbeClientFactory(() =>
    new LLMClient("probe-model", new StubLlmClient([toolCallResponse("ping", {})])),
  );
  return chatStub;
}

const tempVaults: string[] = [];

beforeEach(() => {
  resetCapabilityCache();
  resetChatClientFactory();
  resetComprehensionLlmFactory();
  resetComprehensionVerifySeam();
  resetManifestPopulateLlmFactory();
  resetBuildIndexSeam();
  releaseChatLock();
  closeChatSession();
  closeClarifySession();
  updateSettings(defaultSettings());
});

afterAll(() => {
  setChatClientFactory(null);
  setProbeClientFactory(null);
  setComprehensionLlmFactory(null);
  setManifestPopulateLlmFactory(null);
  setBuildIndexSeam(null);
  releaseChatLock();
  closeChatSession();
  closeClarifySession();
  updateSettings(defaultSettings());
  for (const dir of tempVaults.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Build-stage routing (defect 1 — the follow-up hijack)
// ---------------------------------------------------------------------------

describe("runChatRouter build stage", () => {
  it("runs the stage on the build intent's first question: comprehension → population → index", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    tempVaults.push(vault);
    configure(vault, { minCoverage: 0 });
    installVerifySeam();
    await prepareBuild(vault);
    const compStub = new StubLlmClient(coldRunQueue());
    setComprehensionLlmFactory(() => compStub);
    const popStub = new StubLlmClient([contentOnlyResponse("a/ — cooking recipes\n")]);
    setManifestPopulateLlmFactory(() => new LLMClient(AGENT_MODEL, popStub));
    setBuildIndexSeam(async () => "Index built: 1 file");

    const response = await runChatRouter(DEFAULT_COMPREHENSION_QUESTION, undefined, true);

    expect(response.answer).toContain("The vault is a cooking recipe collection.");
    expect(response.answer).toContain("Index built: 1 file");
    // The population pass replaced the skeleton markers with purposes.
    const manifest = fs.readFileSync(path.join(vault, "_manifest.md"), "utf-8");
    expect(manifest).toContain("## a/ <!-- cooking recipes -->");
    expect(manifest).not.toContain("(needs review)");
    // The lock was released after the run.
    expect(chatLockHolder()).toBeNull();
  });

  it("routes a follow-up question to REGULAR chat, not comprehension or the stage (defect 1)", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    tempVaults.push(vault);
    configure(vault, { minCoverage: 0 });
    installVerifySeam();
    await prepareBuild(vault);
    setComprehensionLlmFactory(() => new StubLlmClient(coldRunQueue()));
    setManifestPopulateLlmFactory(() =>
      new LLMClient(AGENT_MODEL, new StubLlmClient([contentOnlyResponse("a/ — cooking recipes\n")])),
    );
    setBuildIndexSeam(async () => "Index built: 1 file");
    await runChatRouter(DEFAULT_COMPREHENSION_QUESTION, undefined, true);

    // The follow-up: a fresh chat client with a distinctive answer. If the
    // router had routed it to comprehension, the run-once card reuse would
    // have produced the "reused from" answer instead.
    openChatSession(vault);
    const chatStub = installChatSeam("FOLLOW_UP_CHAT_ANSWER");
    const followUp = await runChatRouter("what changed in the vault?", undefined, false);

    expect(followUp.answer).toBe("FOLLOW_UP_CHAT_ANSWER");
    expect(followUp.answer).not.toContain("reused from");
    expect(chatStub.received.length).toBeGreaterThan(0);
    expect(chatLockHolder()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Comprehension vs regular chat routing
// ---------------------------------------------------------------------------

describe("runChatRouter routing rules", () => {
  it("routes the explicit understand-vault question to comprehension", async () => {
    const vault = makeVault({ "a/one.md": "# One\n\n" + "word ".repeat(20) });
    tempVaults.push(vault);
    configure(vault, { minCoverage: 0 });
    installVerifySeam();
    const compStub = new StubLlmClient(coldRunQueue());
    setComprehensionLlmFactory(() => compStub);
    // A chat seam that must NOT be touched by the comprehension path.
    const chatStub = installChatSeam("SHOULD_NOT_APPEAR");

    const response = await runChatRouter(DEFAULT_COMPREHENSION_QUESTION, undefined, false);

    expect(response.answer).toContain("The vault is a cooking recipe collection.");
    expect(chatStub.received).toHaveLength(0);
    expect(compStub.received.length).toBeGreaterThan(0);
    expect(chatLockHolder()).toBeNull();
  });

  it("routes an ordinary question to regular chat, not comprehension", async () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    openChatSession(vault);
    const chatStub = installChatSeam("PLAIN_CHAT_ANSWER");
    // A comprehension seam that must NOT be touched by the chat path.
    const compStub = new StubLlmClient(coldRunQueue());
    setComprehensionLlmFactory(() => compStub);

    const response = await runChatRouter("hello there", undefined, false);

    expect(response.answer).toBe("PLAIN_CHAT_ANSWER");
    expect(compStub.received).toHaveLength(0);
    expect(chatStub.received.length).toBeGreaterThan(0);
    expect(chatLockHolder()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The semaphore contract
// ---------------------------------------------------------------------------

describe("runChatRouter lock contract", () => {
  it("returns the busy answer while the lock is held, with zero LLM calls", async () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    const chatStub = installChatSeam("SHOULD_NOT_APPEAR");
    const compStub = new StubLlmClient(coldRunQueue());
    setComprehensionLlmFactory(() => compStub);
    expect(acquireChatLock("chat")).toBe(true);

    const response = await runChatRouter("hello there", undefined, false);

    expect(response.answer).toContain("Vault maintenance is busy");
    expect(response.answer).toContain("chat in progress");
    expect(response.results).toEqual([]);
    expect(response.citationMap).toEqual({});
    // Zero LLM calls — the rejection is pure.
    expect(chatStub.received).toHaveLength(0);
    expect(compStub.received).toHaveLength(0);
    // The existing holder's lock is untouched; release it cleanly.
    expect(chatLockHolder()).toBe("chat");
    releaseChatLock();
    expect(chatLockHolder()).toBeNull();
  });

  it("a chat question during a build names the build holder in the busy answer", async () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    installChatSeam("SHOULD_NOT_APPEAR");
    expect(acquireChatLock("build")).toBe(true);

    const response = await runChatRouter("hello there", undefined, false);

    expect(response.answer).toBe(chatBusyMessage());
    expect(response.answer).toContain("build in progress");
    releaseChatLock();
  });

  it("a second build command while a chat run is in flight gets the busy answer", async () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    const chatStub = installChatSeam("SHOULD_NOT_APPEAR");
    // A chat run holds the lock...
    expect(acquireChatLock("chat")).toBe(true);

    // ...so a build-stage submission is rejected before any LLM work.
    const response = await runChatRouter(DEFAULT_COMPREHENSION_QUESTION, undefined, true);

    expect(response.answer).toContain("Vault maintenance is busy");
    expect(chatStub.received).toHaveLength(0);
    releaseChatLock();
    expect(chatLockHolder()).toBeNull();
  });

  it("after a busy rejection the lock is acquirable (no leak)", async () => {
    const vault = makeVault({ "a/one.md": "# One" });
    tempVaults.push(vault);
    configure(vault);
    installChatSeam("SHOULD_NOT_APPEAR");
    expect(acquireChatLock("build")).toBe(true);

    await runChatRouter("hello there", undefined, false);
    releaseChatLock();

    // The lock is free again — a fresh run acquires and releases.
    expect(chatLockHolder()).toBeNull();
    const chatStub = installChatSeam("AFTER_BUSY_ANSWER");
    openChatSession(vault);
    const response = await runChatRouter("hello again", undefined, false);
    expect(response.answer).toBe("AFTER_BUSY_ANSWER");
    expect(chatLockHolder()).toBeNull();
  });
});
