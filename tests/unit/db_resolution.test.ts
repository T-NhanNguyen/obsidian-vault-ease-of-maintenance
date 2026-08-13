// Regression tests for the better-sqlite3 fallback path resolution.
//
// Inside Obsidian, bare require("better-sqlite3") fails (electron/js2c
// require stack) and the resolver must rebuild an absolute path from
// settings. This pins the path construction so a future change to
// configDir/pluginDir plumbing cannot silently break the fallback again
// (it did once: an empty pluginDir produced zero candidates).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { updateSettings, defaultSettings } from "../../src/config";
import { collectCandidatePaths } from "../../src/indexer/db";

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nm-db-resolve-"));
  // Simulate an Obsidian vault layout with the plugin installed under a
  // folder name that differs from the manifest id (the landmine scenario).
  fs.mkdirSync(path.join(tmpDir, ".obsidian", "plugins", "obsidian-vault-ease-of-maintenance"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, ".obsidian", "plugins", "ease-of-maintenance"), { recursive: true });
  updateSettings({
    vaultPath: tmpDir,
    configDir: ".obsidian",
    pluginDir: "plugins/obsidian-vault-ease-of-maintenance",
    dbPath: path.join(tmpDir, ".note-maintainer", "index.db"),
  });
});

afterAll(() => {
  updateSettings(defaultSettings());
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("collectCandidatePaths", () => {
  it("builds the exact path from configDir + pluginDir first", () => {
    const paths = collectCandidatePaths();
    expect(paths[0]).toBe(
      path.join(tmpDir, ".obsidian", "plugins", "obsidian-vault-ease-of-maintenance", "node_modules", "better-sqlite3")
    );
  });

  it("scans every plugin folder under the config dir, so a folder-name/id mismatch cannot zero out the candidates", () => {
    const paths = collectCandidatePaths();
    for (const folder of ["obsidian-vault-ease-of-maintenance", "ease-of-maintenance"]) {
      expect(paths).toContain(
        path.join(tmpDir, ".obsidian", "plugins", folder, "node_modules", "better-sqlite3")
      );
    }
  });

  it("still resolves when pluginDir is missing (manifest.dir unpopulated)", () => {
    updateSettings({ pluginDir: "" });
    const paths = collectCandidatePaths();
    // The scan must still yield the plugin folders — this is the exact
    // regression: an empty pluginDir previously produced zero candidates.
    expect(paths.some(p => p.includes("obsidian-vault-ease-of-maintenance"))).toBe(true);
    expect(paths.some(p => p.includes("ease-of-maintenance"))).toBe(true);
    updateSettings({ pluginDir: "plugins/obsidian-vault-ease-of-maintenance" });
  });

  it("never guesses a hardcoded .obsidian path when configDir is unwired", () => {
    // The .obsidian literal fallback was removed: configDir must come from
    // Vault#configDir (wired at onload). With settings unwired, the vault
    // scan is skipped instead of silently assuming a default config folder.
    updateSettings({ configDir: "" });
    const paths = collectCandidatePaths();
    expect(paths.some(p => p.includes(".obsidian"))).toBe(false);
    updateSettings({ configDir: ".obsidian" });
  });
});
