// Disk scanner — finds and reads markdown files in the vault.
// Ported from src/indexer/scanner.py.
// Ignore patterns come from the plugin Settings tab (parseIgnorePatterns).

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
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
  private vaultPath: string;
  private ignorePatterns: string[];

  constructor(vaultPath: string, ignorePatterns: string[] = []) {
    this.vaultPath = vaultPath;
    this.ignorePatterns = ignorePatterns;
  }

  scan(): FileInfo[] {
    const files: FileInfo[] = [];
    if (!fs.existsSync(this.vaultPath) || !fs.statSync(this.vaultPath).isDirectory()) {
      return files;
    }

    const walk = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      // Filter dirs: skip hidden dirs and ignored dirs
      const dirs = entries.filter(e => {
        if (!e.isDirectory()) return false;
        if (e.name.startsWith(".")) return false;
        const dPath = path.join(dir, e.name);
        const rel = path.relative(this.vaultPath, dPath);
        return !isIgnored(rel, this.ignorePatterns);
      });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const fpath = path.join(dir, entry.name);
        const relPath = path.relative(this.vaultPath, fpath);

        if (isIgnored(relPath, this.ignorePatterns)) continue;

        try {
          const stat = fs.statSync(fpath);
          const content = fs.readFileSync(fpath);
          files.push({
            path: relPath,
            title: path.basename(entry.name, ".md"),
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
        walk(path.join(dir, d.name));
      }
    };

    walk(this.vaultPath);
    return files;
  }
}
