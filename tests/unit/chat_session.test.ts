// Chat session store tests — the plugin-side persistent memory for the chat
// tab. Pins: turns land in a session file under .note-maintainer/chat/,
// history is bounded to CHAT_HISTORY_LIMIT, close deletes the file, and
// opening a new session sweeps crash orphans (one active session per vault).

import { describe, it, expect, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { updateSettings, defaultSettings } from "../../src/config";
import {
  openChatSession,
  appendChatTurn,
  chatHistory,
  closeChatSession,
  CHAT_SESSION_DIR,
  CHAT_HISTORY_LIMIT,
} from "../../src/agent/chat_session";

function makeVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "nm-chat-session-"));
}

function sessionFilesIn(vaultDir: string): string[] {
  const dir = path.join(vaultDir, CHAT_SESSION_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.startsWith("session-"));
}

afterAll(() => {
  closeChatSession();
  updateSettings(defaultSettings());
});

describe("chat session store", () => {
  it("persists turns to a session file and serves them as history", () => {
    const vault = makeVault();
    appendChatTurn(vault, "user", "hello");
    appendChatTurn(vault, "assistant", "hi there");

    const files = sessionFilesIn(vault);
    expect(files).toHaveLength(1);
    const lines = fs
      .readFileSync(path.join(vault, CHAT_SESSION_DIR, files[0]), "utf-8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ role: "user", content: "hello" });
    expect(JSON.parse(lines[1])).toEqual({ role: "assistant", content: "hi there" });

    expect(chatHistory()).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("bounds in-memory history to CHAT_HISTORY_LIMIT messages, oldest first dropped", () => {
    const vault = makeVault();
    for (let i = 0; i < CHAT_HISTORY_LIMIT + 5; i++) {
      appendChatTurn(vault, "user", `q${i}`);
      appendChatTurn(vault, "assistant", `a${i}`);
    }
    const history = chatHistory();
    expect(history).toHaveLength(CHAT_HISTORY_LIMIT);
    // 40 turns pushed, 25 dropped: first survivor is a12 (position 25), last is a19.
    expect(history[0]).toEqual({ role: "assistant", content: "a12" });
    expect(history[history.length - 1]).toEqual({ role: "assistant", content: "a19" });
  });

  it("closeChatSession deletes the session file", () => {
    const vault = makeVault();
    appendChatTurn(vault, "user", "q");
    expect(sessionFilesIn(vault)).toHaveLength(1);
    closeChatSession();
    expect(sessionFilesIn(vault)).toHaveLength(0);
  });

  it("openChatSession sweeps orphan session files from a previous crash", () => {
    const vault = makeVault();
    const dir = path.join(vault, CHAT_SESSION_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session-1111111111-dead.jsonl"), "{}");
    fs.writeFileSync(path.join(dir, "session-1111111112-dead.jsonl"), "{}");

    openChatSession(vault);
    expect(sessionFilesIn(vault)).toHaveLength(1);
    closeChatSession();
  });

  it("reopening for the same vault reuses the live session", () => {
    const vault = makeVault();
    appendChatTurn(vault, "user", "first");
    openChatSession(vault); // no-op — same vault, session already active
    expect(chatHistory()).toHaveLength(1);
    closeChatSession();
  });
});
