import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { scanSessionHistory } from "#src/serve/history/catalog.js";
import { readCursorConversationRecords } from "#src/serve/history/cursor.js";
import { readSessionMessages } from "#src/serve/session-history.js";

// 样本由官方 Cursor CLI（agent acp，2026.09.26-dd393fe）写出，说明见 fixtures 目录里的 README。
const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/cursor-acp-session", import.meta.url));
const SESSION_ID = "18518e66-b1dd-4214-99cd-332f1578bd9c";

describe("Cursor ACP history from a real store.db", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.CURSOR_ACP_SESSIONS_DIR;
    process.env.CURSOR_ACP_SESSIONS_DIR = FIXTURE_ROOT;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.CURSOR_ACP_SESSIONS_DIR;
    else process.env.CURSOR_ACP_SESSIONS_DIR = original;
  });

  it("reads every conversation record the CLI wrote", async () => {
    const records = (await readCursorConversationRecords(SESSION_ID)) as Array<{ role: string }>;
    const roles = records.reduce<Record<string, number>>((count, record) => {
      count[record.role] = (count[record.role] ?? 0) + 1;
      return count;
    }, {});
    expect(roles).toEqual({ system: 1, user: 3, assistant: 3, tool: 1 });
  });

  it("lists the session in the Cursor history catalog", async () => {
    const entries = (await scanSessionHistory()).filter((entry) => entry.provider === "cursor");
    expect(entries).toEqual([
      expect.objectContaining({
        id: SESSION_ID,
        provider: "cursor",
        projectDir: "/workspace/cursor-sample",
        title: "TCP Three-Way Handshake",
      }),
    ]);
  });

  it("restores user, assistant and tool messages without Cursor's internal reminders", async () => {
    const messages = await readSessionMessages(SESSION_ID, "cursor");
    expect(messages).toEqual([
      { role: "user", text: "用一句话解释什么是 TCP 三次握手。" },
      {
        role: "assistant",
        text: "TCP 三次握手是客户端与服务器通过 SYN、SYN-ACK、ACK 三次报文交换，确认双方都能收发数据并同步初始序列号，从而建立可靠连接的过程。",
      },
      { role: "user", text: "读取当前目录下的 hello.txt，并告诉我里面写了什么。" },
      { role: "assistant", text: "我来读取当前目录下的 `hello.txt`。" },
      expect.objectContaining({
        role: "activity",
        toolName: "Read",
        status: "done",
        parameters: { path: "/tmp/cursor-sample-cwd/hello.txt" },
      }),
      { role: "assistant", text: "`hello.txt` 里写的是：\n\nhello from the sample file" },
    ]);
  });
});
