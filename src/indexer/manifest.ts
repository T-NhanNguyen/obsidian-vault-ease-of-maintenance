// Manifest parser — extracts folder purposes from _manifest.md.
// Ported from src/indexer/manifest.py

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { settings } from "../config";

export const MANIFEST_FILENAME = "_manifest.md";

function configuredManifestFilename(): string {
  return settings.manifest.filename || MANIFEST_FILENAME;
}

// Regex patterns
const TOC_HEADER = /^(#{1,6})\s+(.+?)\s*(?:<!--\s*(.*?)\s*-->)?\s*$/;
const FILE_ENTRY = /^\s{4,}(.+?)\s*(?:<!--\s*(.*?)\s*-->)?\s*$/;

export interface ManifestFile {
  name: string;
  comment: string;
}

export class ManifestEntry {
  constructor(
    public folderPath: string,
    public purpose: string = "",
    public children: ManifestEntry[] = [],
    public files: ManifestFile[] = [],
  ) {}

  toDict(): Record<string, any> {
    return {
      folder_path: this.folderPath,
      purpose: this.purpose,
      children: this.children.map(c => c.toDict()),
    };
  }

  seedText(): string {
    if (this.purpose) {
      return `${this.folderPath}: ${this.purpose}`;
    }
    return this.folderPath;
  }
}

export class TocReader {
  private vaultPath: string;
  private manifestFilename: string;
  residue: string[] = [];

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.manifestFilename = configuredManifestFilename();
  }

  findManifest(): string | null {
    if (!fs.existsSync(this.vaultPath) || !fs.statSync(this.vaultPath).isDirectory()) {
      return null;
    }
    const walk = (dir: string): string | null => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return null;
      }
      for (const entry of entries) {
        if (entry.name === this.manifestFilename) {
          return path.join(dir, entry.name);
        }
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          const found = walk(path.join(dir, entry.name));
          if (found) return found;
        }
      }
      return null;
    };
    return walk(this.vaultPath);
  }

  parse(manifestPath?: string | null): ManifestEntry[] {
    if (!manifestPath) {
      manifestPath = this.findManifest();
    }
    if (!manifestPath || !fs.existsSync(manifestPath)) return [];
    const content = fs.readFileSync(manifestPath, "utf-8");
    return this._parseContent(content);
  }

  _parseContent(content: string): ManifestEntry[] {
    const entries: ManifestEntry[] = [];
    const stack: ManifestEntry[] = [];
    const stackLevels: number[] = [];
    let current: ManifestEntry | null = null;
    this.residue = [];

    for (const rawLine of content.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      const m = TOC_HEADER.exec(rawLine);
      if (m) {
        const level = m[1].length;
        const text = m[2].trim().replace(/\/$/, "");
        const comment = (m[3] || "").trim();
        if (level === 1) {
          // H1 = vault root marker
          stack.length = 0;
          stackLevels.length = 0;
          current = null;
          continue;
        }
        const entry = new ManifestEntry(text, comment);
        while (stack.length > 0 && stackLevels[stackLevels.length - 1] >= level) {
          stack.pop();
          stackLevels.pop();
        }
        if (stack.length > 0) {
          stack[stack.length - 1].children.push(entry);
        } else {
          entries.push(entry);
        }
        stack.push(entry);
        stackLevels.push(level);
        current = entry;
        continue;
      }

      // File line
      const fm = FILE_ENTRY.exec(rawLine);
      if (fm && current !== null) {
        current.files.push({
          name: fm[1].trim(),
          comment: (fm[2] || "").trim(),
        });
        continue;
      }

      // Unrecognized line
      this.residue.push(rawLine);
    }

    return entries;
  }
}

// Legacy parser patterns
const TOP_LEVEL_FOLDER = /^(\d{2,}_[A-Za-z0-9_\-/]+)(?:\s+\(([^)]*)\))?/;
const INDENTED_ENTRY = /^\s*[│├└─]+\s*(.+?)$/;
const FOLDER_ENTRY = /^\s*(?:\|?\s*├──\s*|│?\s*└──\s*|─+)?\s*([A-Za-z0-9_\-./\s]+?)(?:\s*\(([^)]*)\))?\s*$/;

export class ManifestParser {
  private vaultPath: string;
  private manifestFilename: string;

  constructor(vaultPath: string) {
    this.vaultPath = vaultPath;
    this.manifestFilename = configuredManifestFilename();
  }

  findManifest(): string | null {
    return new TocReader(this.vaultPath).findManifest();
  }

  parse(manifestPath?: string | null): ManifestEntry[] {
    if (!manifestPath) {
      manifestPath = this.findManifest();
    }
    if (!manifestPath || !fs.existsSync(manifestPath)) return [];
    const content = fs.readFileSync(manifestPath, "utf-8");

    // Detect §5.1 markdown-header TOC format
    const looksToc = content.split("\n").some(line =>
      /^#\s+vault\s*(?:<!--.*-->)?\s*$/.test(line) ||
      /^#{2,6}\s+\S+.*\/\s*(?:<!--.*-->)?\s*$/.test(line)
    );
    if (looksToc) {
      return new TocReader(this.vaultPath)._parseContent(content);
    }

    return this.parseLegacyContent(content);
  }

  private shouldSkipLine(line: string): boolean {
    if (!line) return true;
    if (line.startsWith("##") || line.startsWith("```")) return true;
    if (/^-{3,}$/.test(line) || /^_{3,}$/.test(line)) return true;
    if (line.startsWith("|")) return true;
    if (/^\d+\.\s+/.test(line)) return true;
    if (/^-\s+/.test(line) && !/^[│├└─]/.test(line)) return true;
    if (line.length < 3) return true;
    return false;
  }

  private parseLegacyContent(content: string): ManifestEntry[] {
    const lines = content.split("\n");
    const entries: ManifestEntry[] = [];

    for (let i = 0; i < lines.length; i++) {
      const stripped = lines[i].trim();
      if (this.shouldSkipLine(stripped)) continue;

      // Try top-level folder pattern
      const topMatch = TOP_LEVEL_FOLDER.exec(stripped);
      if (topMatch) {
        const folderName = topMatch[1].trim().replace(/\/$/, "");
        const purpose = (topMatch[2] || "").trim();
        entries.push(new ManifestEntry(folderName, purpose));
        continue;
      }

      // Try indented entries under a top-level folder
      const isIndented = ["│", "├", "└", "─", "|"].some(c => stripped.startsWith(c));
      if (entries.length > 0 && isIndented) {
        const indentMatch = INDENTED_ENTRY.exec(stripped);
        if (indentMatch) {
          let name = indentMatch[1].trim();
          let purpose = "";
          const parenMatch = name.match(/\(([^)]+)\)/);
          if (parenMatch) {
            purpose = parenMatch[1];
            name = name.slice(0, parenMatch.index).trim();
          } else {
            const dashMatch = name.match(/\s*[—–-]+\s*(.+)$/);
            if (dashMatch) {
              purpose = dashMatch[1].trim();
              name = name.slice(0, dashMatch.index).trim();
            }
          }
          if (name.endsWith(".md") || ["...", ". . .", "…"].includes(name)) continue;
          if (entries.length > 0) {
            entries[entries.length - 1].children.push(new ManifestEntry(name, purpose));
          }
          continue;
        }
      }

      // Direct folder lines
      const directMatch = FOLDER_ENTRY.exec(stripped);
      if (directMatch) {
        const name = directMatch[1].trim();
        const purpose = (directMatch[2] || "").trim();
        if (name.endsWith(".md") || ["...", ". . .", "…", ""].includes(name)) continue;
        if (!purpose && name.includes(" ") && !/^[\w\-/.]+$/.test(name)) continue;
        entries.push(new ManifestEntry(name, purpose));
      }
    }

    return entries;
  }

  hashManifest(manifestPath?: string | null): string {
    if (!manifestPath) manifestPath = this.findManifest();
    if (!manifestPath || !fs.existsSync(manifestPath)) return "";
    const content = fs.readFileSync(manifestPath);
    return crypto.createHash("sha1").update(content).digest("hex");
  }

  getCommunitySeeds(manifestPath?: string | null): CommunitySeed[] {
    const entries = this.parse(manifestPath);
    const seeds: CommunitySeed[] = [];

    for (const entry of entries) {
      const communityId = crypto.createHash("md5")
        .update(entry.folderPath.toLowerCase())
        .digest("hex")
        .slice(0, 16);

      seeds.push({
        communityId,
        seedSource: "manifest",
        label: entry.purpose || entry.folderPath,
        seedText: entry.seedText(),
        folderPath: entry.folderPath,
      });

      for (const child of entry.children) {
        let childFullPath = child.folderPath;
        if (!childFullPath.startsWith(`${entry.folderPath}/`)) {
          childFullPath = `${entry.folderPath}/${childFullPath}`;
        }
        const childId = crypto.createHash("md5")
          .update(childFullPath.toLowerCase())
          .digest("hex")
          .slice(0, 16);

        seeds.push({
          communityId: childId,
          seedSource: "manifest",
          label: child.purpose || child.folderPath,
          seedText: `${entry.seedText()} > ${child.seedText()}`,
          folderPath: childFullPath,
        });
      }
    }

    return seeds;
  }

  getContentTypeDefaults(manifestPath?: string | null): Record<string, string> {
    const entries = this.parse(manifestPath);
    const defaults: Record<string, string> = {};

    for (const entry of entries) {
      const folder = entry.folderPath.toLowerCase();
      if (["standard", "rule", "reference", "component", "library"].some(kw => folder.includes(kw))) {
        defaults[entry.folderPath] = "reference";
      } else if (["inbox", "dump", "archive"].some(kw => folder.includes(kw))) {
        defaults[entry.folderPath] = "narrative-opinion";
      } else if (["project", "job", "spec", "index"].some(kw => folder.includes(kw))) {
        defaults[entry.folderPath] = "narrative-opinion";
      } else {
        defaults[entry.folderPath] = "reference";
      }
    }

    return defaults;
  }
}

export interface CommunitySeed {
  communityId: string;
  seedSource: string;
  label: string;
  seedText: string;
  folderPath: string;
}
