// Shared temp-vault helpers for agent tool/LLM tests.
// applyEdits and the chat loop need a real directory wired into the global
// settings before the registry is built (getRegistry reads settings.vaultPath
// lazily on first use, so updateSettings + resetRegistry must happen together).

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { updateSettings } from "../../src/config";
import { resetRegistry } from "../../src/agent/tools";

export const NOTE_HANDLE = "f_0001";

export interface ToolVault {
  vaultDir: string;
  notePath: string;
  handle: string;
}

export function makeToolVault(content: string): ToolVault {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "nm-tool-vault-"));
  const notePath = path.join(vaultDir, "note.md");
  fs.writeFileSync(notePath, content, "utf-8");
  updateSettings({ vaultPath: vaultDir, ignorePatterns: "" });
  resetRegistry();
  return { vaultDir, notePath, handle: NOTE_HANDLE };
}

/** Leftover atomic-write temp files would indicate a non-atomic write path. */
export function tmpFilesIn(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.startsWith(".tmp-"));
}
