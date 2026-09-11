// Build-side completion handling: a provider that hits the output cap answers
// with finish_reason "length" and cuts the text mid-line. The incomplete final
// line must go, or a half-written "ENTITY|Bloom Ener" would be stored as a
// real entity name.

import { describe, it, expect } from "vitest";
import {
  dropIncompleteFinalLine,
  isOutputTruncated,
  TRUNCATED_FINISH_REASON,
} from "../../src/indexer/completion_output";

describe("isOutputTruncated", () => {
  it("is true only for the output-cap finish reason", () => {
    expect(TRUNCATED_FINISH_REASON).toBe("length");
    expect(isOutputTruncated("length")).toBe(true);
    expect(isOutputTruncated("stop")).toBe(false);
    expect(isOutputTruncated(undefined)).toBe(false);
  });
});

describe("dropIncompleteFinalLine", () => {
  it("removes the partial last line and keeps the complete ones", () => {
    const text = "ENTITY|Bloom Energy|organization\nENTITY|Cold Bre";

    expect(dropIncompleteFinalLine(text)).toBe("ENTITY|Bloom Energy|organization");
  });

  it("drops only the final line, never earlier ones", () => {
    const text = "ENTITY|A|org\nENTITY|B|org\nREL|A|B|related_to\nENTITY|C";

    expect(dropIncompleteFinalLine(text).split("\n")).toEqual([
      "ENTITY|A|org",
      "ENTITY|B|org",
      "REL|A|B|related_to",
    ]);
  });

  it("returns an empty string when the cap cut before any newline", () => {
    expect(dropIncompleteFinalLine("ENTITY|Bloom Ener")).toBe("");
    expect(dropIncompleteFinalLine("")).toBe("");
  });

  it("keeps every complete line when the text already ends with a newline", () => {
    expect(dropIncompleteFinalLine("ENTITY|A|org\nENTITY|B|org\n")).toBe(
      "ENTITY|A|org\nENTITY|B|org",
    );
  });
});
