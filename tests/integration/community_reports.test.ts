// Integration tests — community reports + global query mode (Phase 4 of the
// GraphRAG buildout). Builds a real index through Indexer.build (fake
// embedder + temp vault, the MemIO-style harness from graph_search.test.ts)
// and pins:
//   1. The four new DB reads (protocol + dispatch round trips through the
//      DatabaseManager facade → in-process worker channel → sql.js engine).
//   2. The build-side report pass: one report per community, the LLM INPUTS
//      (which sections reached each prompt), model + token recording.
//   3. globalQuery end-to-end: reports ranked, synthesis grounded only in
//      reports (no raw section body leaks into the prompt).
//   4. The offline degradation: a build with no LLM leaves reports absent,
//      and globalQuery returns mode "local" with a clear message.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FakeEmbedder } from "../fixtures/fake_embedder";
import { Settings } from "../../src/config";
import { Indexer } from "../../src/indexer/indexer";
import { DatabaseManager } from "../../src/indexer/db";
import { globalQuery } from "../../src/indexer/community_reports";
import type {
  CommunityReportRow,
  CommunityRow,
  SectionSearchRow,
} from "../../src/indexer/db_worker/types";
import type { ReportLlm, ReportLlmResult } from "../../src/indexer/community_reports";

// ---------------------------------------------------------------------------
// Fixture vault — three files, hand-placed wikilinks (same as graph_search).
//   notes/a.md — two sections; links to [[b]] (bare target, no .md)
//   notes/b.md — one section; links back to [[a]]
//   notes/c.md — one section; no links
// ---------------------------------------------------------------------------

const FIXTURE_FILES: Record<string, string> = {
  "notes/a.md": [
    "# Bloom Energy",
    "Bloom fuel cells. See [[b]] for the datacenter angle.",
    "",
    "## Fuel Cell Stack",
    "Efficiency above 60 percent.",
    "",
  ].join("\n"),
  "notes/b.md": [
    "# Datacenter Power",
    "AI data centers consume power. Back to [[a]].",
    "",
  ].join("\n"),
  "notes/c.md": [
    "# Coffee Notes",
    "Cold brew ratios and bean origins.",
    "",
  ].join("\n"),
};

// Raw section BODY phrases (never headings) — must never leak into the
// global synthesis prompt (reports do not echo section bodies).
const RAW_SECTION_BODIES = ["Efficiency above 60 percent", "Cold brew ratios"];

function makeSettings(vaultPath: string, dbPath: string, reports?: Partial<Settings["reports"]>): Settings {
  return {
    vaultPath,
    configDir: "",
    pluginDir: "",
    dbPath,
    inboxFolder: "",
    ignorePatterns: "",
    api: { baseUrl: "http://localhost:9999/v1", apiKey: "test-key" },
    embedding: { model: "test", dimensions: 64 },
    manifest: { filename: "_manifest.md" },
    query: { topK: 5, depth: 1, maxFanOut: 8, maxSeeds: 8, topReports: 3 },
    agent: { model: "test", thinking: { chat: false, build: false, sort: false } },
    preview: { enabled: true, ttlMinutes: 30 },
    index: { warnMb: 256 },
    graph: {
      clusterThreshold: 0.5,
      inferredThreshold: 0.7,
      inferredMaxEdgesPerSection: 3,
    },
    reports: { contextCapTokens: 3000, ...reports },
    extraction: { contextCapTokens: 3000 },
  };
}

/**
 * Deterministic build-side report LLM: records every prompt it was given and
 * returns a fixed template that echoes ONLY the community label — never the
 * section bodies — so the "no raw section leak" assertion is meaningful.
 */
class BuildReportLlm implements ReportLlm {
  readonly seenUsers: string[] = [];

  async complete(_system: string, user: string): Promise<ReportLlmResult> {
    this.seenUsers.push(user);
    const label = user.match(/Community: ([^\n]+)/)?.[1] || "unknown";
    return {
      content: `Summary of ${label}.\n- Topic A.\n- Topic B.`,
      totalTokens: 9,
      model: "stub-model",
    };
  }
}

/** Global-mode synthesis stub — one queued answer. */
class StubSynthesisLlm implements ReportLlm {
  readonly seenUsers: string[] = [];

  async complete(_system: string, user: string): Promise<ReportLlmResult> {
    this.seenUsers.push(user);
    return { content: "Global answer.", totalTokens: 5, model: "stub-model" };
  }
}

interface BuiltHarness {
  settings: Settings;
  fakeEmbedder: FakeEmbedder;
  reportLlm: BuildReportLlm;
}

async function buildWithReports(reports?: Partial<Settings["reports"]>): Promise<BuiltHarness> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-reports-"));
  const vaultDir = path.join(tmpDir, "vault");
  for (const [relPath, content] of Object.entries(FIXTURE_FILES)) {
    const fullPath = path.join(vaultDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content.replace(/^\n+/, ""));
  }
  const settings = makeSettings(vaultDir, path.join(tmpDir, "index.db"), reports);
  const fakeEmbedder = new FakeEmbedder(64);
  const reportLlm = new BuildReportLlm();
  const indexer = new Indexer(settings, fakeEmbedder, reportLlm);
  await indexer.build();
  return { settings, fakeEmbedder, reportLlm };
}

async function buildWithoutReports(): Promise<{ settings: Settings }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-reports-none-"));
  const vaultDir = path.join(tmpDir, "vault");
  for (const [relPath, content] of Object.entries(FIXTURE_FILES)) {
    const fullPath = path.join(vaultDir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content.replace(/^\n+/, ""));
  }
  const settings = makeSettings(vaultDir, path.join(tmpDir, "index.db"));
  const indexer = new Indexer(settings, new FakeEmbedder(64));
  await indexer.build();
  return { settings };
}

// ---------------------------------------------------------------------------
// New DB reads — protocol + dispatch round trips
// ---------------------------------------------------------------------------

describe("Community-report DB reads (round trips)", () => {
  it("upsertCommunityReport / getCommunityReport / getAllCommunityReports round-trip", async () => {
    const { settings } = await buildWithReports();
    const db = new DatabaseManager(settings.dbPath);
    try {
      const communities = await db.getAllCommunities();
      expect(communities.length).toBeGreaterThanOrEqual(1);
      const first = communities[0];

      // The build wrote a report for every community (all have sections).
      const all = await db.getAllCommunityReports();
      expect(all).toHaveLength(communities.length);
      for (const row of all) {
        expect(row.report).toContain("Summary of");
        expect(row.model).toBe("stub-model");
        expect(row.tokens).toBe(9);
        expect(row.built_at).toBeTruthy();
      }

      // Distinct write round-trips through the facade + worker channel.
      await db.upsertCommunityReport({
        communityId: first.community_id,
        report: "overwritten",
        model: "m2",
        tokens: 3,
      });
      const row = await db.getCommunityReport(first.community_id);
      expect(row?.report).toBe("overwritten");
      expect(row?.model).toBe("m2");
      expect(row?.tokens).toBe(3);

      expect(await db.getCommunityReport("does-not-exist")).toBeNull();
    } finally {
      await db.close();
    }
  });

  it("getSectionsForCommunity returns the member sections in node_key order", async () => {
    const { settings } = await buildWithReports();
    const db = new DatabaseManager(settings.dbPath);
    try {
      const communities = await db.getAllCommunities();
      const allSectionKeys = (await db.getSectionKeys()).map((k) => k.node_key);

      let total = 0;
      for (const community of communities) {
        const sections = await db.getSectionsForCommunity(community.community_id);
        total += sections.length;
        // Deterministic: ordered by node_key, no embedding blob loaded.
        const keys = sections.map((s) => s.node_key);
        expect(keys).toEqual([...keys].sort());
        for (const s of sections) {
          expect(Object.prototype.hasOwnProperty.call(s, "embedding")).toBe(false);
        }
      }

      // Every section belongs to exactly one community (Phase-3 contract).
      expect(total).toBe(allSectionKeys.length);
      expect(await db.getSectionsForCommunity("does-not-exist")).toEqual([]);
    } finally {
      await db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Build-side report pass — inputs asserted, not just stored output
// ---------------------------------------------------------------------------

describe("Build-side community reports", () => {
  it("generates one report per community and feeds each prompt only that community's sections", async () => {
    const { settings, reportLlm } = await buildWithReports();
    const db = new DatabaseManager(settings.dbPath);
    try {
      const communities = await db.getAllCommunities();
      const sections = await db.getSectionKeys();

      // One LLM call per community, in community_id order (the same order
      // getAllCommunities returns — prompts are recorded in call order).
      expect(reportLlm.seenUsers).toHaveLength(communities.length);

      // The INPUTS, per community: each prompt contains EXACTLY that
      // community's member section headings (by node_key order) and no other
      // community's — the report never sees foreign sections.
      const memberKeysByCommunity: string[][] = [];
      for (const community of communities) {
        const memberKeys = (await db.getSectionsForCommunity(community.community_id))
          .map((s) => s.node_key);
        memberKeysByCommunity.push(memberKeys);
      }

      reportLlm.seenUsers.forEach((user, i) => {
        const community = communities[i];
        const memberKeys = memberKeysByCommunity[i];
        expect(user).toContain(`Community: ${community.label || community.community_id}`);

        // Exact heading set in the prompt = the community's members.
        const headingsInPrompt = user
          .split("\n")
          .filter((line) => line.startsWith("### "))
          .map((line) => line.slice(4));
        expect(headingsInPrompt).toEqual(
          memberKeys.map((key) => key.split("::")[1] || key),
        );
      });

      // Union coverage: every section is in exactly one community's prompt
      // (the Phase-3 "every section assigned" contract, at the report input).
      const covered = new Set(memberKeysByCommunity.flat());
      expect(covered.size).toBe(sections.length);
    } finally {
      await db.close();
    }
  });

  it("is idempotent — a rebuild writes the same reports", async () => {
    const { settings, fakeEmbedder, reportLlm } = await buildWithReports();
    const rebuilt = new Indexer(settings, fakeEmbedder, reportLlm);
    await rebuilt.build();

    const db = new DatabaseManager(settings.dbPath);
    try {
      const rows = await db.getAllCommunityReports();
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(row.report).toContain("Summary of");
        expect(row.model).toBe("stub-model");
        expect(row.tokens).toBe(9);
      }
    } finally {
      await db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// ReportsConfigTuning — config.yaml `reports:` section must actually reach
// the build (single source of truth; the GraphConfigTuning pattern).
// ---------------------------------------------------------------------------

describe("ReportsConfigTuning (config.yaml reports: section reaches the build)", () => {
  it("reports.context_cap_tokens tunes the per-community context budget", async () => {
    // Every fixture section body is longer than 20 chars (5 tokens) — with a
    // 5-token cap NOTHING fits, so no report is generated (zero LLM calls,
    // table empty). Deterministic: the cap drops whole sections in node_key
    // order, independent of how the sections clustered.
    const tiny = await buildWithReports({ contextCapTokens: 5 });
    expect(tiny.reportLlm.seenUsers).toHaveLength(0);
    const tinyDb = new DatabaseManager(tiny.settings.dbPath);
    try {
      expect(await tinyDb.getAllCommunityReports()).toEqual([]);
    } finally {
      await tinyDb.close();
    }

    // Default 3000-token cap: all four fixture sections fit their community
    // prompts (monotonic by construction — the cap only ever drops sections).
    const roomy = await buildWithReports();
    const headings = roomy.reportLlm.seenUsers.flatMap((user) =>
      user.split("\n").filter((line) => line.startsWith("### ")),
    );
    expect(headings).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// globalQuery end-to-end on a built index
// ---------------------------------------------------------------------------

describe("globalQuery on a built index", () => {
  it("answers from reports and grounds the synthesis only in them", async () => {
    const { settings, fakeEmbedder } = await buildWithReports();
    const db = new DatabaseManager(settings.dbPath);
    try {
      const llm = new StubSynthesisLlm();
      const result = await globalQuery(fakeEmbedder, db, llm, "what is this vault about?");

      expect(result.mode).toBe("global");
      expect(result.answer).toBe("Global answer.");
      expect(result.selectedReports.length).toBeGreaterThanOrEqual(1);

      // Map-reduce: the synthesis prompt is grounded ONLY in the reports —
      // report text + community labels, never raw section bodies.
      const user = llm.seenUsers[0];
      expect(user).toContain("Summary of");
      for (const body of RAW_SECTION_BODIES) {
        expect(user).not.toContain(body);
      }
    } finally {
      await db.close();
    }
  });

  it("degrades to local mode with a clear message when no reports exist", async () => {
    const { settings } = await buildWithoutReports();
    const fakeEmbedder = new FakeEmbedder(64);
    const db = new DatabaseManager(settings.dbPath);
    try {
      expect(await db.getAllCommunityReports()).toEqual([]);

      const llm = new StubSynthesisLlm();
      const result = await globalQuery(fakeEmbedder, db, llm, "what is this vault about?");

      expect(result.mode).toBe("local");
      expect(result.answer).toBe("");
      expect(result.message).toContain("No community reports");
      expect(llm.seenUsers).toHaveLength(0); // no LLM call — no hang
    } finally {
      await db.close();
    }
  });
});

// Type-only re-export guard: these types are part of the public contract the
// facade surfaces (keeps the import list honest).
export type { CommunityReportRow, CommunityRow, SectionSearchRow };
