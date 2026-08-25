// Spec-key regression (defect 2) — the chat spec key is intent-aware so the
// plain-chat command, the understand-vault command, and the cold build's
// chat are DISTINCT specs. Before this change, build-cold chat and
// understand-vault shared the key `chat:Understand this vault.`; ReviewCore
// deduped on it, so opening "Build graphrag index" while the comprehension
// pane was open never installed the build query — the pane kept routing
// every follow-up through comprehension.

import { describe, it, expect } from "vitest";
import { specKey, type ChatReviewSpec, type ReviewSpec } from "../../src/types";
import { DEFAULT_COMPREHENSION_QUESTION } from "../../src/comprehension/runtime_comprehension";

function chatSpec(overrides: Partial<ChatReviewSpec> = {}): ReviewSpec {
  return {
    kind: "chat",
    query: async () => ({ answer: "", results: [], citationMap: {} }),
    ...overrides,
  };
}

describe("specKey for chat specs", () => {
  it("plain chat and understand-vault are distinct specs", () => {
    const plain = specKey(chatSpec({ intent: "chat" }));
    const understand = specKey(
      chatSpec({ intent: "chat", initialQuestion: DEFAULT_COMPREHENSION_QUESTION }),
    );
    expect(plain).toBe("chat:chat:plain");
    expect(understand).toBe(`chat:chat:${DEFAULT_COMPREHENSION_QUESTION}`);
    expect(plain).not.toBe(understand);
  });

  it("build-cold chat and understand-vault are distinct specs (defect 2)", () => {
    const understand = specKey(
      chatSpec({ intent: "chat", initialQuestion: DEFAULT_COMPREHENSION_QUESTION }),
    );
    const build = specKey(
      chatSpec({ intent: "build", initialQuestion: DEFAULT_COMPREHENSION_QUESTION }),
    );
    expect(build).toBe(`chat:build:${DEFAULT_COMPREHENSION_QUESTION}`);
    expect(build).not.toBe(understand);
  });

  it("a missing intent defaults to plain chat; a build pane without an initial question still differs", () => {
    expect(specKey(chatSpec())).toBe("chat:chat:plain");
    expect(specKey(chatSpec({ intent: "build" }))).toBe("chat:build:plain");
  });

  it("the same intent + question dedupes to one key (pane reuse works)", () => {
    const a = specKey(chatSpec({ intent: "chat", initialQuestion: DEFAULT_COMPREHENSION_QUESTION }));
    const b = specKey(chatSpec({ intent: "chat", initialQuestion: DEFAULT_COMPREHENSION_QUESTION }));
    expect(a).toBe(b);
  });
});
