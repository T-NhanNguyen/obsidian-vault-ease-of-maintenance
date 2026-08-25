// Chat gate tests — the single-slot semaphore that serializes chat-surface
// runs and the headless warm build. Pure TS module (no Obsidian imports), so
// the tests exercise acquire/release/holder directly and the withChatLock
// wrapper's try/finally release on both success and error paths.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  acquireChatLock,
  releaseChatLock,
  chatLockHolder,
  withChatLock,
  type ChatLockOwner,
} from "../../src/chat_gate";

beforeEach(() => {
  releaseChatLock();
});

afterEach(() => {
  releaseChatLock();
});

describe("acquireChatLock / releaseChatLock / chatLockHolder", () => {
  it("acquires when free and reports the holder", () => {
    expect(chatLockHolder()).toBeNull();
    expect(acquireChatLock("chat")).toBe(true);
    expect(chatLockHolder()).toBe("chat");
  });

  it("rejects a second acquire while held (either owner)", () => {
    expect(acquireChatLock("build")).toBe(true);
    expect(acquireChatLock("chat")).toBe(false);
    expect(acquireChatLock("build")).toBe(false);
    expect(chatLockHolder()).toBe("build");
  });

  it("release clears the holder; release when free is a no-op", () => {
    expect(acquireChatLock("chat")).toBe(true);
    releaseChatLock();
    expect(chatLockHolder()).toBeNull();
    // Defensive: release always runs in a finally — it must never throw
    // when the lock is not held.
    expect(() => releaseChatLock()).not.toThrow();
    expect(chatLockHolder()).toBeNull();
  });

  it("after release the lock is acquirable again", () => {
    expect(acquireChatLock("chat")).toBe(true);
    releaseChatLock();
    expect(acquireChatLock("build")).toBe(true);
    expect(chatLockHolder()).toBe("build");
  });
});

describe("withChatLock", () => {
  it("runs the task under the lock and releases on success", async () => {
    let holderDuringTask: ChatLockOwner | null = null;
    const result = await withChatLock("chat", async () => {
      holderDuringTask = chatLockHolder();
      return "done";
    }, () => "busy");

    expect(result).toBe("done");
    expect(holderDuringTask).toBe("chat");
    expect(chatLockHolder()).toBeNull();
  });

  it("returns busyResult without running the task when the lock is held", async () => {
    expect(acquireChatLock("build")).toBe(true);
    let ran = false;
    const result = await withChatLock("chat", async () => {
      ran = true;
      return "task";
    }, () => "busy");

    expect(result).toBe("busy");
    expect(ran).toBe(false);
    // The holder's own lock is untouched.
    expect(chatLockHolder()).toBe("build");
  });

  it("releases the lock when the task throws", async () => {
    await expect(
      withChatLock("build", async () => {
        throw new Error("boom");
      }, () => "busy"),
    ).rejects.toThrow("boom");
    expect(chatLockHolder()).toBeNull();
  });

  it("releases even when busyResult is also used (no leak across calls)", async () => {
    expect(acquireChatLock("build")).toBe(true);
    await withChatLock("chat", async () => "task", () => "busy");
    releaseChatLock();
    // After the real holder releases, a fresh acquire succeeds.
    expect(acquireChatLock("chat")).toBe(true);
    releaseChatLock();
  });
});
