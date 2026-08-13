// Disk scanner — finds and reads markdown files in the vault.
// Ported from src/indexer/scanner.py.
// Ignore patterns come from the plugin Settings tab (parseIgnorePatterns).
// All disk access is confined to the vault via VaultIO (src/io/vault_io.ts).

import * as crypto from "crypto";
import * as path from "path";
import { VaultIO } from "../io/vault_io";
import { isIgnored } from "../agent/engine";

export interface FileInfo {
  path: string;
  title: string;
  created_date: string | null;
  modified_date: number;
  version: number;
  content_hash: string;
  content: string;
}

export class Scanner {
  private io: VaultIO;
  private ignorePatterns: string[];

  constructor(vaultPath: string, ignorePatterns: string[] = []) {
    this.io = new VaultIO(vaultPath);
    this.ignorePatterns = ignorePatterns;
  }

  scan(): FileInfo[] {
    const files: FileInfo[] = [];
    if (!this.io.isDirectory("")) {
      return files;
    }

    const walk = (relDir: string): void => {
      const { files: fileNames, dirs: dirNames } = this.io.list(relDir);

      // Filter dirs: skip hidden dirs and ignored dirs
      const dirs = dirNames.filter(name => {
        if (name.startsWith(".")) return false;
        const rel = relDir ? `${relDir}/${name}` : name;
        return !isIgnored(rel, this.ignorePatterns);
      });

      for (const name of fileNames) {
        if (!name.endsWith(".md")) continue;
        const relPath = relDir ? `${relDir}/${name}` : name;

        if (isIgnored(relPath, this.ignorePatterns)) continue;

        try {
          const stat = this.io.stat(relPath);
          if (!stat) continue;
          const content = this.io.readBinary(relPath);
          files.push({
            path: relPath,
            title: path.basename(name, ".md"),
            created_date: null,
            modified_date: stat.mtimeMs,
            version: 1,
            content_hash: crypto.createHash("sha1").update(content).digest("hex"),
            content: content.toString("utf-8"),
          });
        } catch {
          // Skip files we can't read
        }
      }

      for (const d of dirs) {
        walk(relDir ? `${relDir}/${d}` : d);
      }
    };

    walk("");
    return files;
  }
}
