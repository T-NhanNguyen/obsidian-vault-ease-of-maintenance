// Unit tests for the markdown pre-transform that sanitizes agent output
// before Obsidian's MarkdownRenderer sees it (embeds, raw HTML, citations).

import { describe, it, expect } from "vitest";
import { escapeAgentMarkdown } from "../../src/render-markdown";

describe("escapeAgentMarkdown", () => {
  it("escapes double-bracket citations (the model's [[n]] drift) as literal text", () => {
    expect(escapeAgentMarkdown('date [[1]].')).toBe("date \\[\\[1\\]\\].");
  });

  it("escapes single-bracket citations (the prompt's [n] form)", () => {
    expect(escapeAgentMarkdown("see [2] here")).toBe("see \\[2\\] here");
  });

  it("handles multiple citations without double-escaping", () => {
    expect(escapeAgentMarkdown("[[1]] and [2]")).toBe("\\[\\[1\\]\\] and \\[2\\]");
  });

  it("leaves plain text untouched", () => {
    const plain = "A **bold** claim with no citations.";
    expect(escapeAgentMarkdown(plain)).toBe(plain);
  });

  it("escapes raw HTML (untrusted model output)", () => {
    const escaped = escapeAgentMarkdown("<script>alert(1)</script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).not.toContain("<script>");
  });

  it("escapes vault embed syntax (opening ![[ suffices — trailing ]] is inert)", () => {
    expect(escapeAgentMarkdown("![[embed]]")).toBe("!\\[\\[embed]]");
  });
});
