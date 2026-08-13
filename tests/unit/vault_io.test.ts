// VaultIO confinement layer tests — the two guards (path normalization +
// realpath verification) plus the file-operation semantics the plugin relies
// on (atomic write, mkdirp, copy/rename/remove). Any regression here is a
// confinement regression: this class is the only place fs appears in src/.

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { VaultIO } from "../../src/io/vault_io";
import { Journal, JournalEntry } from "../../src/agent/engine";
import { updateSettings, defaultSettings } from "../../src/config";

const OUT_OF_SCOPE = "OUT_OF_SCOPE";

function makeVault(): { vault: string; io: VaultIO } {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-vaultio-"));
  return { vault, io: new VaultIO(vault) };
}

function expectOutOfScope(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("expected OUT_OF_SCOPE rejection");
  } catch (e) {
    expect((e as Error).message).toContain(OUT_OF_SCOPE);
  }
}

afterAll(() => {
  updateSettings(defaultSettings());
});

describe("VaultIO guards", () => {
  it("rejects parent traversal (../outside.md)", () => {
    const { io } = makeVault();
    expectOutOfScope(() => io.readText("../outside.md"));
    expectOutOfScope(() => io.readText("a/../../outside.md"));
  });

  it("rejects absolute paths", () => {
    const { vault, io } = makeVault();
    expectOutOfScope(() => io.readText(path.join(vault, "note.md")));
    expectOutOfScope(() => io.writeTextAtomic("/tmp/absolute.md", "x"));
  });

  it("rejects symlink escapes — a vault symlink pointing outside the vault", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-vaultio-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nm-outside-"));
    const io = new VaultIO(vault);
    try {
      fs.writeFileSync(path.join(outside, "secret.txt"), "secret", "utf-8");
      fs.symlinkSync(outside, path.join(vault, "escape"));
      expectOutOfScope(() => io.readText("escape/secret.txt"));
      expectOutOfScope(() => io.stat("escape/secret.txt"));
      expectOutOfScope(() => io.list("escape"));
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects file-symlink escapes — a file link pointing outside the vault", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-vaultio-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nm-outside-"));
    const io = new VaultIO(vault);
    try {
      fs.writeFileSync(path.join(outside, "secret.md"), "outside content", "utf-8");
      fs.symlinkSync(path.join(outside, "secret.md"), path.join(vault, "secret.md"));
      expectOutOfScope(() => io.readText("secret.md"));
      expectOutOfScope(() => io.copy("secret.md", "copy.md"));
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("accepts symlinks that stay inside the vault", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-vaultio-"));
    const io = new VaultIO(vault);
    try {
      io.mkdirp("real");
      io.writeTextAtomic("real/note.md", "hello");
      fs.symlinkSync(path.join(vault, "real"), path.join(vault, "alias"));
      expect(io.readText("alias/note.md")).toBe("hello");
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  it("rejects empty-string I/O and unreadable targets via OUT_OF_SCOPE", () => {
    const { io } = makeVault();
    expect(io.isDirectory("")).toBe(true);
    expect(io.exists("missing.md")).toBe(false);
    expect(io.stat("missing.md")).toBeNull();
  });
});

describe("VaultIO file semantics", () => {
  it("writeTextAtomic writes content and leaves no .tmp- files behind", () => {
    const { vault, io } = makeVault();
    try {
      io.writeTextAtomic("note.md", "hello");
      expect(io.readText("note.md")).toBe("hello");
      const leftover = fs.readdirSync(vault).filter((n) => n.startsWith(".tmp-"));
      expect(leftover).toEqual([]);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  it("writeTextAtomic creates parent directories (journal style)", () => {
    const { io } = makeVault();
    io.writeTextAtomic(".note-maintainer/sort-journal.jsonl", "line\n");
    expect(io.readText(".note-maintainer/sort-journal.jsonl")).toBe("line\n");
  });

  it("appendText appends lines", () => {
    const { io } = makeVault();
    io.appendText(".note-maintainer/sort-journal.jsonl", "one\n");
    io.appendText(".note-maintainer/sort-journal.jsonl", "two\n");
    expect(io.readText(".note-maintainer/sort-journal.jsonl")).toBe("one\ntwo\n");
  });

  it("copy duplicates content; rename moves; remove deletes recursively", () => {
    const { vault, io } = makeVault();
    try {
      io.writeTextAtomic("dir/a.md", "a");
      io.copy("dir/a.md", "dir/b.md");
      expect(io.readText("dir/b.md")).toBe("a");

      io.rename("dir/b.md", "dir/c.md");
      expect(io.exists("dir/b.md")).toBe(false);
      expect(io.readText("dir/c.md")).toBe("a");

      io.remove("dir");
      expect(io.isDirectory("dir")).toBe(false);
      expect(fs.readdirSync(vault)).toEqual([]);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });

  it("stat reports mtimeMs and size", () => {
    const { io } = makeVault();
    io.writeTextAtomic("note.md", "12345");
    const info = io.stat("note.md");
    expect(info).not.toBeNull();
    expect(info!.size).toBe(5);
    expect(info!.mtimeMs).toBeGreaterThan(0);
  });

  it("list returns files and dirs as names", () => {
    const { io } = makeVault();
    io.writeTextAtomic("a.md", "");
    io.writeTextAtomic("sub/b.md", "");
    io.writeTextAtomic(".hidden.md", "");
    const root = io.list("");
    expect(root.files.sort()).toEqual([".hidden.md", "a.md"]);
    expect(root.dirs).toEqual(["sub"]);
    const sub = io.list("sub");
    expect(sub.files).toEqual(["b.md"]);
    expect(io.list("missing")).toEqual({ files: [], dirs: [] });
  });

  it("absPath returns a path inside the vault root", () => {
    const { vault, io } = makeVault();
    const abs = io.absPath(".note-maintainer/index.db");
    expect(abs.startsWith(io.rootAbs + path.sep)).toBe(true);
    expect(path.resolve(abs)).not.toBe(path.join(vault, ".."));
  });
});

describe("Journal relocation (confinement)", () => {
  it("default journal path lives inside the vault under .note-maintainer/", () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), "nm-journal-"));
    try {
      updateSettings({ vaultPath: vault });
      const journal = new Journal();
      journal.append(new JournalEntry("u_0001", "k", "f_0001", "pending"));
      expect(journal.allEntries().length).toBe(1);
      expect(
        fs.existsSync(path.join(vault, ".note-maintainer", "sort-journal.jsonl"))
      ).toBe(true);
      // The old tmpdir location must NOT be touched.
      expect(
        fs.existsSync(path.join(os.tmpdir(), "note-maintainer-sort-journal.jsonl"))
      ).toBe(false);
      journal.clear();
      expect(
        fs.existsSync(path.join(vault, ".note-maintainer", "sort-journal.jsonl"))
      ).toBe(false);
    } finally {
      fs.rmSync(vault, { recursive: true, force: true });
    }
  });
});
