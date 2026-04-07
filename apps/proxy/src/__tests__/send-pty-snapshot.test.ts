import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

// vi.mock factory 在 hoisting 后执行，不能引用外部变量
// 用固定的临时目录路径代替
const MOCK_BASE = join(tmpdir(), "pty-snap-test");

vi.mock("../paths.js", async () => {
  const { mkdirSync: mkdir } = await import("node:fs");
  const { join: pathJoin } = await import("node:path");
  const { tmpdir: tmp } = await import("node:os");
  const base = pathJoin(tmp(), "pty-snap-test");
  mkdir(base, { recursive: true });
  return {
    sessionPaths: (sessionId: string) => {
      const dir = pathJoin(base, sessionId);
      return {
        dir,
        events: pathJoin(dir, "events.bin"),
        snapshot: pathJoin(dir, "snapshot.bin"),
        workerSock: pathJoin(dir, "worker.sock"),
      };
    },
    sessionDir: (sessionId: string) => pathJoin(base, sessionId),
    DATA_DIR: base,
    ensureDirectories: () => {},
    SOCK_PATH: pathJoin(base, "test.sock"),
    PID_PATH: pathJoin(base, "test.pid"),
    STOPPED_PATH: pathJoin(base, "stopped"),
    SESSIONS_PATH: pathJoin(base, "sessions.json"),
    LOG_PATH: pathJoin(base, "test.log"),
    RUN_DIR: base,
    STATE_DIR: base,
  };
});

vi.mock("../event-store.js", () => {
  class MockEventStore {
    getSeq() { return 42; }
    close() {}
  }
  return {
    EventStore: MockEventStore,
    EventType: { PTY_OUTPUT: 1, SNAPSHOT: 2, PTY_INPUT: 3, SIZE: 4 },
  };
});

import { sendPtySnapshot } from "../serve.js";
import type { RelayConnection } from "../relay-connection.js";

const logger = pino({ level: "silent" });

function createMockRelay(): RelayConnection {
  return {
    send: vi.fn(),
  } as unknown as RelayConnection;
}

describe("sendPtySnapshot", () => {
  const sessionId = "test-pty-session";

  beforeEach(() => {
    const sessionDir = join(MOCK_BASE, sessionId);
    mkdirSync(sessionDir, { recursive: true });
  });

  it("reads snapshot.bin, base64 encodes, sends pty_snapshot envelope to relay", () => {
    const snapshotContent = Buffer.from("fake-terminal-snapshot-data");
    writeFileSync(join(MOCK_BASE, sessionId, "snapshot.bin"), snapshotContent);

    const relay = createMockRelay();
    sendPtySnapshot(sessionId, relay, logger);

    expect(relay.send).toHaveBeenCalledTimes(1);
    const envelope = (relay.send as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(envelope.type).toBe("pty_snapshot");
    expect(envelope.sessionId).toBe(sessionId);
    expect(envelope.seq).toBe(43); // getSeq()=42 + 1
    expect(envelope.source).toBe("proxy");
    expect(envelope.payload.data).toBe(snapshotContent.toString("base64"));

    // base64 解码后应该还原
    const decoded = Buffer.from(envelope.payload.data, "base64");
    expect(decoded.toString()).toBe("fake-terminal-snapshot-data");
  });

  it("does nothing when snapshot.bin does not exist", () => {
    // 不创建 snapshot.bin
    const relay = createMockRelay();
    const newSession = "no-snapshot-session";
    mkdirSync(join(MOCK_BASE, newSession), { recursive: true });

    sendPtySnapshot(newSession, relay, logger);

    expect(relay.send).not.toHaveBeenCalled();
  });

  it("does not throw on relay.send error", () => {
    const snapshotContent = Buffer.from("data");
    writeFileSync(join(MOCK_BASE, sessionId, "snapshot.bin"), snapshotContent);

    const relay = createMockRelay();
    (relay.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("connection lost");
    });

    // 不应抛异常
    expect(() => sendPtySnapshot(sessionId, relay, logger)).not.toThrow();
  });
});
