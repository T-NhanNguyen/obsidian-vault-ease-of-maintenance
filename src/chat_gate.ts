// Chat gate — the single-slot semaphore that serializes every chat-surface
// run (plain chat, comprehension, the cold build stage) and the headless
// warm build against each other. While a run holds the lock, a new
// submission is rejected immediately (busy answer, no queueing): both share
// module-level registries (chatSearchResults, the citation tracker) and the
// sql.js DB, and concurrent LLM runs would contend for the local server's
// prefill memory.
//
// Pure TS: no Obsidian imports, unit-testable in isolation.

export type ChatLockOwner = "chat" | "build";

let currentHolder: ChatLockOwner | null = null;

/** Acquires the chat lock for the given owner. Returns false when the lock
 * is already held — the caller must surface the busy answer. */
export function acquireChatLock(owner: ChatLockOwner): boolean {
  if (currentHolder !== null) return false;
  currentHolder = owner;
  return true;
}

/** Releases the chat lock. A no-op when not held — release always runs in a
 * finally, including after a busy rejection, so it must never throw. */
export function releaseChatLock(): void {
  currentHolder = null;
}

/** The current lock holder, or null when the chat is free. */
export function chatLockHolder(): ChatLockOwner | null {
  return currentHolder;
}

/** Runs `task` while holding the chat lock; when the lock is already held,
 * returns `busyResult()` immediately instead (zero work, zero LLM calls).
 * The lock is released in a finally — on success, on error, and when the
 * caller detaches mid-run. */
export async function withChatLock<T>(
  owner: ChatLockOwner,
  task: () => Promise<T>,
  busyResult: () => T,
): Promise<T> {
  if (!acquireChatLock(owner)) return busyResult();
  try {
    return await task();
  } finally {
    releaseChatLock();
  }
}
