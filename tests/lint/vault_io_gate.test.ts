// Vault-confinement source gate — mirrors the store-review bot's "Direct
// Filesystem Access" heuristic from the other side: instead of flagging the
// bundle for shipping fs, it asserts that raw fs access is IMPOSSIBLE in the
// source except inside the single chokepoint (src/io/vault_io.ts). Every
// read/write/copy/rename/stat/list in the plugin must route through VaultIO.
//
// Keeps the chokepoint honest: if someone imports fs into a new module, this
// test fails at the PR boundary, not in the store review.

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const MAIN_TS = path.join(REPO_ROOT, "main.ts");
const CHOKEPOINT = path.join(SRC_DIR, "io", "vault_io.ts");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && full.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

function codeWithoutComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("vault confinement source gate", () => {
  it("routes all file I/O through src/io/vault_io.ts", () => {
    const files = [MAIN_TS, ...walk(SRC_DIR)].filter((f) => f !== CHOKEPOINT);
    const offenders: Array<{ file: string; match: string }> = [];

    for (const file of files) {
      const code = codeWithoutComments(fs.readFileSync(file, "utf-8"));
      for (const line of code.split("\n")) {
        if (/import\s+(?:\*\s+as\s+)?fs\s+from\s+["']fs["']/.test(line) ||
            /require\(\s*["']fs["']\s*\)/.test(line) ||
            /\bfs\./.test(line)) {
          offenders.push({ file: path.relative(REPO_ROOT, file), match: line.trim() });
        }
      }
    }

    expect(
      offenders,
      "raw fs access outside the VaultIO chokepoint — route through src/io/vault_io.ts",
    ).toEqual([]);
  });
});
