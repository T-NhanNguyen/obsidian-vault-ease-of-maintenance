// VaultIO — the single confinement chokepoint for every file operation.
//
// Every read/write/copy/rename/remove/list in src/ routes through this class
// (see tests/lint/vault_io_gate.test.ts — the gate that keeps it the only
// place `fs` appears). All methods accept ONLY vault-relative paths and two
// guards run before any I/O:
//
//   1. Path normalization — absolute paths and any `..` segment are rejected.
//   2. Realpath verification — the deepest existing ancestor of the target
//      must resolve inside the vault root, which defeats symlink escapes
//      (a symlink inside the vault pointing at a directory outside it).
//
// The one documented exception to confinement is the better-sqlite3 native
// module, which opens settings.dbPath directly (inside the vault, verified
// via absPath()). The module itself is the native binding — VaultIO never
// hands out an unverified absolute path.

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileStatInfo {
  mtimeMs: number;
  size: number;
}

export interface ListResult {
  files: string[];
  dirs: string[];
}

// ---------------------------------------------------------------------------
// VaultIO
// ---------------------------------------------------------------------------

export class VaultIO {
  readonly rootAbs: string;

  constructor(root: string) {
    const resolved = path.resolve(root);
    try {
      // Pin the real root so symlinked vault roots compare cleanly.
      this.rootAbs = fs.realpathSync(resolved);
    } catch {
      // Nonexistent root (e.g. creating the DB dir for the first time):
      // realpath the deepest existing ancestor and re-append the missing
      // suffix so rootAbs stays canonical even before it exists.
      this.rootAbs = VaultIO.canonicalizePendingRoot(resolved);
    }
  }

  private static canonicalizePendingRoot(resolved: string): string {
    const missing: string[] = [];
    let current = resolved;
    for (;;) {
      try {
        return path.join(fs.realpathSync(current), ...missing.reverse());
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        missing.push(path.basename(current));
        const parent = path.dirname(current);
        if (parent === current) return resolved;
        current = parent;
      }
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  readText(rel: string): string {
    return fs.readFileSync(this.absFor(rel), "utf-8");
  }

  readBinary(rel: string): Buffer {
    return fs.readFileSync(this.absFor(rel));
  }

  writeTextAtomic(rel: string, content: string): void {
    const normalized = this.resolveRel(rel);
    this.mkdirp(this.parentRel(normalized));
    const targetAbs = this.absFor(normalized);
    const tmpAbs = this.tmpPathFor(targetAbs);
    fs.writeFileSync(tmpAbs, content, "utf-8");
    fs.renameSync(tmpAbs, targetAbs);
  }

  appendText(rel: string, content: string): void {
    const normalized = this.resolveRel(rel);
    this.mkdirp(this.parentRel(normalized));
    fs.appendFileSync(this.absFor(normalized), content, "utf-8");
  }

  copy(from: string, to: string): void {
    fs.copyFileSync(this.absFor(from), this.absFor(to));
  }

  remove(rel: string): void {
    fs.rmSync(this.absFor(rel), { recursive: true, force: true });
  }

  rename(from: string, to: string): void {
    fs.renameSync(this.absFor(from), this.absFor(to));
  }

  mkdirp(rel: string): void {
    const abs = this.absFor(rel);
    const missing: string[] = [];
    let current = abs;
    while (!this.looseExists(current)) {
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    for (let i = missing.length - 1; i >= 0; i--) {
      try {
        fs.mkdirSync(missing[i]);
      } catch (e) {
        // Raced with another creator, or the path exists as a (dangling)
        // symlink — either way the directory is now usable or the real
        // error surfaces at the next real I/O.
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
  }

  exists(rel: string): boolean {
    try {
      return fs.existsSync(this.absFor(rel));
    } catch {
      return false;
    }
  }

  isDirectory(rel: string): boolean {
    try {
      return fs.statSync(this.absFor(rel)).isDirectory();
    } catch {
      return false;
    }
  }

  stat(rel: string): FileStatInfo | null {
    try {
      const st = fs.statSync(this.absFor(rel));
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }

  list(rel: string = ""): ListResult {
    let abs: string;
    try {
      abs = this.absFor(rel);
    } catch {
      return { files: [], dirs: [] };
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return { files: [], dirs: [] };
    }
    const files: string[] = [];
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.isFile()) files.push(entry.name);
      else if (entry.isDirectory()) dirs.push(entry.name);
    }
    return { files, dirs };
  }

  /** Guarded absolute path — the single exception: better-sqlite3 opens it. */
  absPath(rel: string): string {
    return this.absFor(rel);
  }

  // ------------------------------------------------------------------
  // Guards
  // ------------------------------------------------------------------

  private resolveRel(rel: string): string {
    if (typeof rel !== "string" || rel.length === 0) {
      return ""; // vault root
    }
    if (path.isAbsolute(rel)) {
      throw new Error(`OUT_OF_SCOPE: absolute path not allowed: '${rel}'`);
    }
    const segments = rel.split(/[\\/]+/).filter((seg) => seg.length > 0 && seg !== ".");
    if (segments.some((seg) => seg === "..")) {
      throw new Error(`OUT_OF_SCOPE: parent traversal not allowed: '${rel}'`);
    }
    return segments.join("/");
  }

  private absFor(rel: string): string {
    const normalized = this.resolveRel(rel);
    const abs = normalized
      ? path.join(this.rootAbs, ...normalized.split("/"))
      : this.rootAbs;
    this.assertInsideVault(normalized || ".", abs);
    return abs;
  }

  /** Realpath of the deepest existing ancestor must stay at-or-below the root
   *  (inside the vault) or at-or-above it (the root does not exist yet and we
   *  are creating it). Any other resolution — a symlink pointing outside the
   *  vault — is rejected. */
  private assertInsideVault(rel: string, abs: string): void {
    let current = abs;
    for (;;) {
      let real: string;
      try {
        real = fs.realpathSync(current);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        const parent = path.dirname(current);
        if (parent === current) {
          throw new Error(`OUT_OF_SCOPE: '${rel}' cannot be confined to the vault`);
        }
        current = parent;
        continue;
      }
      if (real === this.rootAbs ||
          real.startsWith(this.rootAbs + path.sep) ||
          this.rootAbs.startsWith(real + path.sep)) {
        return;
      }
      throw new Error(
        `OUT_OF_SCOPE: '${rel}' resolves outside the vault (realpath ${real})`
      );
    }
  }

  private looseExists(abs: string): boolean {
    try {
      return fs.existsSync(abs);
    } catch {
      return false;
    }
  }

  private parentRel(normalized: string): string {
    const idx = normalized.lastIndexOf("/");
    return idx < 0 ? "." : normalized.slice(0, idx);
  }

  private tmpPathFor(targetAbs: string): string {
    const tmpName = `.tmp-${crypto.randomBytes(4).toString("hex")}`;
    return path.join(path.dirname(targetAbs), tmpName);
  }
}
