// PendingStore — filesystem-backed state for proposed changes awaiting review.
// Ported from src/preview/pending.py

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PENDING_DIRNAME = ".note-maintainer/pending";
const DEFAULT_TTL_MINUTES = 30;
const BAK_SUFFIX = ".bak";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProposedChange {
  filePath: string;
  vaultPath: string;
  original: string;
  cleaned: string;
  validation: Record<string, [boolean, string]>;
  opsApplied: number;
  opsRejected: number;
  changed: boolean;
}

export interface PendingEntry {
  pendingId: string;
  meta: Record<string, any>;
  original: string;
  cleaned: string;
  dirPath: string;
  filePath: string;
  vaultPath: string;
  beforeHash: string;
  expired: boolean;
}

export interface AcceptResult {
  pendingId: string;
  filePath: string;
  bakPath: string;
  success: boolean;
  freshnessWarning: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class UnknownPending extends Error {
  constructor(pendingId: string) {
    super(`No such pending entry: ${pendingId}`);
  }
}

export class ExpiredPending extends Error {
  constructor(pendingId: string) {
    super(`Pending entry expired: ${pendingId}`);
  }
}

// ---------------------------------------------------------------------------
// PendingStore
// ---------------------------------------------------------------------------

export class PendingStore {
  vaultPath: string;
  root: string;
  ttlMinutes: number;

  constructor(vaultPath: string, ttlMinutes: number = DEFAULT_TTL_MINUTES) {
    this.vaultPath = path.resolve(vaultPath);
    this.root = path.join(this.vaultPath, PENDING_DIRNAME);
    this.ttlMinutes = ttlMinutes;
    if (!fs.existsSync(this.root)) {
      fs.mkdirSync(this.root, { recursive: true });
    }
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  create(proposal: ProposedChange, diffHtml: string = ""): string {
    const user = this.getUser();

    // Delete existing pending entries for the same file by the same user
    const existing = this.findEntriesForFile(proposal.filePath, user);
    for (const pid of existing) {
      this.reject(pid);
    }

    const pendingId = this.generateId(user);
    const entryDir = path.join(this.root, pendingId);
    fs.mkdirSync(entryDir, { recursive: true });

    const validationPassed = Object.values(proposal.validation).every(v => v[0]);
    const checks: Record<string, string> = {};
    for (const [k, v] of Object.entries(proposal.validation)) {
      checks[k] = v[1];
    }

    const meta = {
      pending_id: pendingId,
      file_path: proposal.filePath,
      vault_path: proposal.vaultPath,
      user,
      created_at: new Date().toISOString(),
      ttl_minutes: this.ttlMinutes,
      before_hash: crypto.createHash("sha1").update(proposal.original).digest("hex").slice(0, 12),
      ops_applied: proposal.opsApplied,
      ops_rejected: proposal.opsRejected,
      validation: { passed: validationPassed, checks },
    };

    this.writeAtomic(path.join(entryDir, "meta.json"), JSON.stringify(meta, null, 2));
    this.writeAtomic(path.join(entryDir, "original.md"), proposal.original);
    this.writeAtomic(path.join(entryDir, "cleaned.md"), proposal.cleaned);
    if (diffHtml) {
      this.writeAtomic(path.join(entryDir, "diff.html"), diffHtml);
    }

    // Run sweep opportunistically
    this.sweep();
    return pendingId;
  }

  resolve(pendingId: string): PendingEntry {
    const entryDir = path.join(this.root, pendingId);
    if (!fs.existsSync(entryDir) || !fs.statSync(entryDir).isDirectory()) {
      throw new UnknownPending(pendingId);
    }

    const metaPath = path.join(entryDir, "meta.json");
    if (!fs.existsSync(metaPath)) {
      throw new UnknownPending(pendingId);
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
    const originalFile = path.join(entryDir, "original.md");
    const cleanedFile = path.join(entryDir, "cleaned.md");

    const original = fs.existsSync(originalFile) ? fs.readFileSync(originalFile, "utf-8") : "";
    const cleaned = fs.existsSync(cleanedFile) ? fs.readFileSync(cleanedFile, "utf-8") : "";

    const expired = this.isExpired(meta);

    if (expired) {
      throw new ExpiredPending(pendingId);
    }

    return {
      pendingId,
      meta,
      original,
      cleaned,
      dirPath: entryDir,
      filePath: meta.file_path,
      vaultPath: meta.vault_path,
      beforeHash: meta.before_hash,
      expired,
    };
  }

  accept(pendingId: string): AcceptResult {
    const entry = this.resolve(pendingId);
    const target = path.join(entry.vaultPath, entry.filePath);
    const bakPath = target + BAK_SUFFIX;

    // Check freshness
    let freshnessWarning = false;
    if (fs.existsSync(target)) {
      const currentHash = crypto.createHash("sha1")
        .update(fs.readFileSync(target))
        .digest("hex")
        .slice(0, 12);
      freshnessWarning = currentHash !== entry.beforeHash;
    }

    // Atomic copy current → .bak
    if (fs.existsSync(target)) {
      let suffix = 0;
      let tmpBak = `${bakPath}.tmp.${suffix}`;
      while (fs.existsSync(tmpBak)) {
        suffix += 1;
        tmpBak = `${bakPath}.tmp.${suffix}`;
      }
      fs.copyFileSync(target, tmpBak);
      fs.renameSync(tmpBak, bakPath);
    }

    // Atomic write cleaned content
    const tmpPath = path.join(path.dirname(target), `.tmp-${crypto.randomBytes(4).toString("hex")}`);
    fs.writeFileSync(tmpPath, entry.cleaned, "utf-8");
    fs.renameSync(tmpPath, target);

    // Delete pending directory
    fs.rmSync(entry.dirPath, { recursive: true, force: true });

    let msg = `Accepted — ${path.basename(entry.filePath)} written`;
    if (freshnessWarning) {
      msg += ". The file was modified during review; see .bak for the modified original.";
    } else {
      msg += ` (backup at ${entry.filePath}${BAK_SUFFIX})`;
    }

    return {
      pendingId,
      filePath: entry.filePath,
      bakPath,
      success: true,
      freshnessWarning,
      message: msg,
    };
  }

  reject(pendingId: string): void {
    const entryDir = path.join(this.root, pendingId);
    if (fs.existsSync(entryDir)) {
      fs.rmSync(entryDir, { recursive: true, force: true });
    }
  }

  sweep(): number {
    let count = 0;
    const now = Date.now();
    const ttlMs = this.ttlMinutes * 60 * 1000;

    if (!fs.existsSync(this.root)) return 0;

    for (const entryName of fs.readdirSync(this.root)) {
      const entryDir = path.join(this.root, entryName);
      if (!fs.statSync(entryDir).isDirectory()) continue;

      const metaPath = path.join(entryDir, "meta.json");
      if (!fs.existsSync(metaPath)) {
        fs.rmSync(entryDir, { recursive: true, force: true });
        count += 1;
        continue;
      }

      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        const created = meta.created_at || "";
        if (!created) {
          fs.rmSync(entryDir, { recursive: true, force: true });
          count += 1;
          continue;
        }
        const age = now - new Date(created).getTime();
        if (age > ttlMs) {
          fs.rmSync(entryDir, { recursive: true, force: true });
          count += 1;
        }
      } catch {
        fs.rmSync(entryDir, { recursive: true, force: true });
        count += 1;
      }
    }
    return count;
  }

  listByUser(user: string): Array<Record<string, any>> {
    const results: Array<Record<string, any>> = [];
    if (!fs.existsSync(this.root)) return results;

    for (const entryName of fs.readdirSync(this.root)) {
      const entryDir = path.join(this.root, entryName);
      if (!fs.statSync(entryDir).isDirectory()) continue;

      const metaPath = path.join(entryDir, "meta.json");
      if (!fs.existsSync(metaPath)) continue;

      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (meta.user !== user) continue;

        if (this.isExpired(meta)) continue;
        results.push(meta);
      } catch { /* skip */ }
    }
    return results;
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private findEntriesForFile(filePath: string, user: string): string[] {
    const found: string[] = [];
    if (!fs.existsSync(this.root)) return found;

    for (const entryName of fs.readdirSync(this.root)) {
      const entryDir = path.join(this.root, entryName);
      if (!fs.statSync(entryDir).isDirectory()) continue;

      const metaPath = path.join(entryDir, "meta.json");
      if (!fs.existsSync(metaPath)) continue;

      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (meta.file_path === filePath && meta.user === user) {
          found.push(meta.pending_id);
        }
      } catch { /* skip */ }
    }
    return found;
  }

  private isExpired(meta: Record<string, any>): boolean {
    const created = meta.created_at || "";
    const ttl = meta.ttl_minutes || this.ttlMinutes;
    if (!created) return true;
    try {
      const age = Date.now() - new Date(created).getTime();
      return age > ttl * 60 * 1000;
    } catch {
      return true;
    }
  }

  private generateId(user: string = ""): string {
    const now = new Date();
    const ts = now.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
    const rand = crypto.randomBytes(4).toString("hex").slice(0, 4);
    const safeUser = user.slice(0, 12).replace(/[^a-zA-Z0-9\-_]/g, "");
    if (safeUser) return `p_${safeUser}_${ts}_${rand}`;
    return `p_${ts}_${rand}`;
  }

  private writeAtomic(filePath: string, content: string): void {
    const tmpPath = path.join(path.dirname(filePath), `.tmp-${crypto.randomBytes(4).toString("hex")}`);
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  private getUser(): string {
    try {
      return os.userInfo().username;
    } catch {
      return "user";
    }
  }
}
