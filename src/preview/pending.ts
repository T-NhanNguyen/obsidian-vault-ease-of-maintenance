// PendingStore — filesystem-backed state for proposed changes awaiting review.
// Ported from src/preview/pending.py
// All disk access is confined to the vault via VaultIO (src/io/vault_io.ts).

import * as crypto from "crypto";
import * as path from "path";
import * as os from "os";
import { VaultIO } from "../io/vault_io";

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

// meta.json shape written by create() and read back by resolve/sweep/list.
export interface PendingMeta {
  pending_id: string;
  file_path: string;
  vault_path: string;
  user: string;
  created_at: string;
  ttl_minutes: number;
  before_hash: string;
  ops_applied: number;
  ops_rejected: number;
  validation: { passed: boolean; checks: Record<string, string> };
}

export interface PendingEntry {
  pendingId: string;
  meta: PendingMeta;
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
  private io: VaultIO;
  private rootRel: string;

  constructor(vaultPath: string, ttlMinutes: number = DEFAULT_TTL_MINUTES) {
    this.vaultPath = path.resolve(vaultPath);
    this.io = new VaultIO(this.vaultPath);
    this.rootRel = PENDING_DIRNAME;
    this.root = path.join(this.vaultPath, PENDING_DIRNAME);
    this.ttlMinutes = ttlMinutes;
    this.io.mkdirp(this.rootRel);
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
    const entryRel = `${this.rootRel}/${pendingId}`;
    this.io.mkdirp(entryRel);

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

    this.writeAtomic(`${entryRel}/meta.json`, JSON.stringify(meta, null, 2));
    this.writeAtomic(`${entryRel}/original.md`, proposal.original);
    this.writeAtomic(`${entryRel}/cleaned.md`, proposal.cleaned);
    if (diffHtml) {
      this.writeAtomic(`${entryRel}/diff.html`, diffHtml);
    }

    // Run sweep opportunistically
    this.sweep();
    return pendingId;
  }

  resolve(pendingId: string): PendingEntry {
    const entryRel = `${this.rootRel}/${pendingId}`;
    if (!this.io.isDirectory(entryRel)) {
      throw new UnknownPending(pendingId);
    }

    const metaRel = `${entryRel}/meta.json`;
    if (!this.io.exists(metaRel)) {
      throw new UnknownPending(pendingId);
    }

    const meta = JSON.parse(this.io.readText(metaRel)) as PendingMeta;
    const originalRel = `${entryRel}/original.md`;
    const cleanedRel = `${entryRel}/cleaned.md`;

    const original = this.io.exists(originalRel) ? this.io.readText(originalRel) : "";
    const cleaned = this.io.exists(cleanedRel) ? this.io.readText(cleanedRel) : "";

    const expired = this.isExpired(meta);

    if (expired) {
      throw new ExpiredPending(pendingId);
    }

    return {
      pendingId,
      meta,
      original,
      cleaned,
      dirPath: this.absFor(entryRel),
      filePath: meta.file_path,
      vaultPath: meta.vault_path,
      beforeHash: meta.before_hash,
      expired,
    };
  }

  accept(pendingId: string): AcceptResult {
    const entry = this.resolve(pendingId);
    const targetRel = entry.filePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const bakRel = `${targetRel}${BAK_SUFFIX}`;

    // Check freshness
    let freshnessWarning = false;
    if (this.io.exists(targetRel)) {
      const currentHash = crypto.createHash("sha1")
        .update(this.io.readBinary(targetRel))
        .digest("hex")
        .slice(0, 12);
      freshnessWarning = currentHash !== entry.beforeHash;
    }

    // Atomic copy current → .bak
    if (this.io.exists(targetRel)) {
      let suffix = 0;
      let tmpBak = `${bakRel}.tmp.${suffix}`;
      while (this.io.exists(tmpBak)) {
        suffix += 1;
        tmpBak = `${bakRel}.tmp.${suffix}`;
      }
      this.io.copy(targetRel, tmpBak);
      this.io.rename(tmpBak, bakRel);
    }

    // Atomic write cleaned content
    this.io.writeTextAtomic(targetRel, entry.cleaned);

    // Delete pending directory
    this.io.remove(`${this.rootRel}/${pendingId}`);

    let msg = `Accepted — ${path.basename(entry.filePath)} written`;
    if (freshnessWarning) {
      msg += ". The file was modified during review; see .bak for the modified original.";
    } else {
      msg += ` (backup at ${entry.filePath}${BAK_SUFFIX})`;
    }

    return {
      pendingId,
      filePath: entry.filePath,
      bakPath: this.absFor(bakRel),
      success: true,
      freshnessWarning,
      message: msg,
    };
  }

  reject(pendingId: string): void {
    const entryRel = `${this.rootRel}/${pendingId}`;
    if (this.io.exists(entryRel)) {
      this.io.remove(entryRel);
    }
  }

  sweep(): number {
    let count = 0;
    const now = Date.now();
    const ttlMs = this.ttlMinutes * 60 * 1000;

    if (!this.io.isDirectory(this.rootRel)) return 0;

    const { dirs } = this.io.list(this.rootRel);
    for (const entryName of dirs) {
      const entryRel = `${this.rootRel}/${entryName}`;
      const metaRel = `${entryRel}/meta.json`;
      if (!this.io.exists(metaRel)) {
        this.io.remove(entryRel);
        count += 1;
        continue;
      }

      try {
        const meta = JSON.parse(this.io.readText(metaRel)) as PendingMeta;
        const created = meta.created_at || "";
        if (!created) {
          this.io.remove(entryRel);
          count += 1;
          continue;
        }
        const age = now - new Date(created).getTime();
        if (age > ttlMs) {
          this.io.remove(entryRel);
          count += 1;
        }
      } catch {
        this.io.remove(entryRel);
        count += 1;
      }
    }
    return count;
  }

  listByUser(user: string): PendingMeta[] {
    const results: PendingMeta[] = [];
    if (!this.io.isDirectory(this.rootRel)) return results;

    const { dirs } = this.io.list(this.rootRel);
    for (const entryName of dirs) {
      const metaRel = `${this.rootRel}/${entryName}/meta.json`;
      if (!this.io.exists(metaRel)) continue;

      try {
        const meta = JSON.parse(this.io.readText(metaRel)) as PendingMeta;
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
    if (!this.io.isDirectory(this.rootRel)) return found;

    const { dirs } = this.io.list(this.rootRel);
    for (const entryName of dirs) {
      const metaRel = `${this.rootRel}/${entryName}/meta.json`;
      if (!this.io.exists(metaRel)) continue;

      try {
        const meta = JSON.parse(this.io.readText(metaRel)) as PendingMeta;
        if (meta.file_path === filePath && meta.user === user) {
          found.push(meta.pending_id);
        }
      } catch { /* skip */ }
    }
    return found;
  }

  private isExpired(meta: PendingMeta): boolean {
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

  private writeAtomic(rel: string, content: string): void {
    this.io.writeTextAtomic(rel, content);
  }

  private absFor(rel: string): string {
    return this.io.absPath(rel);
  }

  private getUser(): string {
    try {
      return os.userInfo().username;
    } catch {
      return "user";
    }
  }
}
