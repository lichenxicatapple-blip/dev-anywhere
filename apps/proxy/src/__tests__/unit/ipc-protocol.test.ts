import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";

describe("IPC Protocol", () => {
  async function importIpc() {
    return await import("#src/ipc-protocol.js");
  }

  describe("serializeIpc", () => {
    it("produces valid JSON terminated with newline", async () => {
      const { serializeIpc } = await importIpc();
      const msg = { type: "session_status_update" as const, sessionId: "s1", state: "idle" };
      const result = serializeIpc(msg);

      expect(result.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(result.trim())).not.toThrow();
    });

    it("round-trips through JSON.parse", async () => {
      const { serializeIpc } = await importIpc();
      const msg = {
        type: "session_create_request" as const,
        name: "test-session",
        mode: "pty" as const,
      };
      const serialized = serializeIpc(msg);
      const parsed = JSON.parse(serialized.trim());

      expect(parsed).toEqual(msg);
    });
  });

  describe("createIpcReader", () => {
    it("parses complete NDJSON messages from a stream", async () => {
      const { createIpcReader, serializeIpc } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];

      createIpcReader(stream, (msg) => messages.push(msg));

      stream.write(serializeIpc({ type: "session_status_update", sessionId: "s1", state: "idle" }));
      stream.write(
        serializeIpc({
          type: "session_create_request",
          name: "test",
          mode: "pty",
        }),
      );
      stream.end();

      // LineBuffer emits asynchronously through the transform pipeline
      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ type: "session_status_update", sessionId: "s1", state: "idle" });
      expect(messages[1]).toEqual({
        type: "session_create_request",
        name: "test",
        mode: "pty",
      });
    });

    it("handles messages split across data events", async () => {
      const { createIpcReader } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];

      createIpcReader(stream, (msg) => messages.push(msg));

      // Split a single message across two writes
      const fullMsg = JSON.stringify({ type: "session_status_update", sessionId: "s1", state: "idle" }) + "\n";
      const splitPoint = Math.floor(fullMsg.length / 2);
      stream.write(fullMsg.slice(0, splitPoint));
      stream.write(fullMsg.slice(splitPoint));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "session_status_update", sessionId: "s1", state: "idle" });
    });

    it("skips empty lines", async () => {
      const { createIpcReader } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];

      createIpcReader(stream, (msg) => messages.push(msg));

      stream.write(JSON.stringify({ type: "session_status_update", sessionId: "s1", state: "idle" }) + "\n");
      stream.write("\n");
      stream.write(JSON.stringify({ type: "session_create_request", mode: "pty" }) + "\n");
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(2);
    });

    it("logs warning for invalid JSON instead of throwing", async () => {
      const { createIpcReader } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      createIpcReader(stream, (msg) => messages.push(msg));

      stream.write("not-valid-json\n");
      stream.write(JSON.stringify({ type: "session_status_update", sessionId: "s1", state: "idle" }) + "\n");
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("IpcMessageSchema", () => {
    it("rejects unknown message type", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({ type: "unknown_type" });
      expect(result.success).toBe(false);
    });
  });
});

// === Phase 3d: Worker message path tests ===
describe("Worker Protocol", () => {
  async function importIpc() {
    return await import("#src/ipc-protocol.js");
  }

  describe("serializeWorkerMsg", () => {
    it("produces valid NDJSON (JSON + newline)", async () => {
      const { serializeWorkerMsg } = await importIpc();
      const msg = { type: "worker_stop" as const };
      const result = serializeWorkerMsg(msg);

      expect(result.endsWith("\n")).toBe(true);
      expect(() => JSON.parse(result.trim())).not.toThrow();
    });

    it("round-trips through JSON.parse", async () => {
      const { serializeWorkerMsg } = await importIpc();
      const msg = {
        type: "worker_input" as const,
        content: "hello world",
      };
      const serialized = serializeWorkerMsg(msg);
      const parsed = JSON.parse(serialized.trim());

      expect(parsed).toEqual(msg);
    });
  });

  describe("createWorkerReader", () => {
    it("parses complete worker messages from a stream", async () => {
      const { createWorkerReader, serializeWorkerMsg } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];

      createWorkerReader(stream, (msg) => messages.push(msg));

      stream.write(serializeWorkerMsg({ type: "worker_ready", pid: 12345 }));
      stream.write(serializeWorkerMsg({ type: "worker_event", seq: 1, event: { kind: "text", content: "hello" } }));
      stream.write(serializeWorkerMsg({ type: "worker_approval_request", requestId: "r1", toolName: "bash", input: { cmd: "ls" } }));
      stream.write(serializeWorkerMsg({ type: "worker_exit", code: 0 }));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(4);
      expect(messages[0]).toEqual({ type: "worker_ready", pid: 12345 });
      expect(messages[1]).toEqual({ type: "worker_event", seq: 1, event: { kind: "text", content: "hello" } });
      expect(messages[2]).toEqual({ type: "worker_approval_request", requestId: "r1", toolName: "bash", input: { cmd: "ls" } });
      expect(messages[3]).toEqual({ type: "worker_exit", code: 0 });
    });

    it("handles messages split across data events", async () => {
      const { createWorkerReader, serializeWorkerMsg } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];

      createWorkerReader(stream, (msg) => messages.push(msg));

      const fullMsg = serializeWorkerMsg({ type: "worker_stop" });
      const splitPoint = Math.floor(fullMsg.length / 2);
      stream.write(fullMsg.slice(0, splitPoint));
      stream.write(fullMsg.slice(splitPoint));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "worker_stop" });
    });

    it("skips invalid JSON without crashing, continues processing", async () => {
      const { createWorkerReader, serializeWorkerMsg } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];

      createWorkerReader(stream, (msg) => messages.push(msg));

      stream.write("garbage-not-json\n");
      stream.write(serializeWorkerMsg({ type: "worker_stop" }));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "worker_stop" });
    });
  });

  describe("WorkerMessageSchema contract", () => {
    const WORKER_MESSAGE_SAMPLES: Array<{ type: string; payload: Record<string, unknown> }> = [
      { type: "worker_input", payload: { type: "worker_input", content: "test" } },
      { type: "worker_stop", payload: { type: "worker_stop" } },
      { type: "worker_approval_response", payload: { type: "worker_approval_response", requestId: "r1", behavior: "allow" } },
      { type: "worker_replay", payload: { type: "worker_replay", lastSeq: 42 } },
      { type: "worker_event", payload: { type: "worker_event", seq: 1, event: { kind: "text", data: { nested: true } } } },
      { type: "worker_exit", payload: { type: "worker_exit", code: 0 } },
      { type: "worker_approval_request", payload: { type: "worker_approval_request", requestId: "r2", toolName: "bash", input: { cmd: "ls", args: ["-la"] } } },
      { type: "worker_ready", payload: { type: "worker_ready", pid: 999 } },
      { type: "worker_replay_done", payload: { type: "worker_replay_done", replayedCount: 10 } },
      { type: "worker_claude_session_id", payload: { type: "worker_claude_session_id", sessionId: "cs-123" } },
      { type: "worker_whitelist_add", payload: { type: "worker_whitelist_add", toolName: "read" } },
    ];

    it.each(WORKER_MESSAGE_SAMPLES)(
      "accepts valid $type message",
      async ({ payload }) => {
        const { WorkerMessageSchema } = await importIpc();
        const result = WorkerMessageSchema.safeParse(payload);
        expect(result.success).toBe(true);
      },
    );

    it("rejects unknown worker message type", async () => {
      const { WorkerMessageSchema } = await importIpc();
      const result = WorkerMessageSchema.safeParse({ type: "worker_unknown" });
      expect(result.success).toBe(false);
    });
  });
});
