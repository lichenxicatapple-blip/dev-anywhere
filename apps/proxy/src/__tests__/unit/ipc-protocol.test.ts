import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";

describe("IPC Protocol", () => {
  async function importIpc() {
    return await import("#src/ipc/ipc-protocol.js");
  }

  describe("serializeIpc", () => {
    it("produces valid JSON terminated with newline", async () => {
      const { serializeIpc } = await importIpc();
      const msg = {
        type: "session_status_update" as const,
        sessionId: "s1",
        state: "idle" as const,
      };
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
        cwd: "/tmp/test",
        pid: 12345,
      };
      const serialized = serializeIpc(msg);
      const parsed = JSON.parse(serialized.trim());

      expect(parsed).toEqual(msg);
    });

    it("accepts session create response with hook context", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "session_create_response",
        sessionId: "s1",
        hook: {
          provider: "claude",
          sessionId: "s1",
          hookUrl: "http://127.0.0.1:17654/hook",
          marker: "marker-1",
          token: "token-1",
        },
      });

      expect(result.success).toBe(true);
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
          cwd: "/tmp/test",
          pid: 12345,
        }),
      );
      stream.end();

      // LineBuffer emits asynchronously through the transform pipeline
      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({
        type: "session_status_update",
        sessionId: "s1",
        state: "idle",
      });
      expect(messages[1]).toEqual({
        type: "session_create_request",
        name: "test",
        mode: "pty",
        cwd: "/tmp/test",
        pid: 12345,
      });
    });

    it("handles messages split across data events", async () => {
      const { createIpcReader } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];

      createIpcReader(stream, (msg) => messages.push(msg));

      // Split a single message across two writes
      const fullMsg =
        JSON.stringify({ type: "session_status_update", sessionId: "s1", state: "idle" }) + "\n";
      const splitPoint = Math.floor(fullMsg.length / 2);
      stream.write(fullMsg.slice(0, splitPoint));
      stream.write(fullMsg.slice(splitPoint));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: "session_status_update",
        sessionId: "s1",
        state: "idle",
      });
    });

    it("skips empty lines", async () => {
      const { createIpcReader } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];

      createIpcReader(stream, (msg) => messages.push(msg));

      stream.write(
        JSON.stringify({ type: "session_status_update", sessionId: "s1", state: "idle" }) + "\n",
      );
      stream.write("\n");
      stream.write(
        JSON.stringify({
          type: "session_create_request",
          mode: "pty",
          cwd: "/tmp/test",
          pid: 12345,
        }) + "\n",
      );
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(2);
    });

    it("emits error on stream for invalid JSON, continues processing valid messages", async () => {
      const { createIpcReader } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];
      const errors: Error[] = [];
      stream.on("error", (err) => errors.push(err));

      createIpcReader(stream, (msg) => messages.push(msg));

      stream.write("not-valid-json\n");
      stream.write(
        JSON.stringify({ type: "session_status_update", sessionId: "s1", state: "idle" }) + "\n",
      );
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/IPC message parse error/);
    });
  });

  describe("IpcMessageSchema", () => {
    it("rejects unknown message type", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({ type: "unknown_type" });
      expect(result.success).toBe(false);
    });
  });

  describe("encodeBinaryIpcFrame", () => {
    it("produces correct binary frame format: [0x00][4B len LE][1B sessionId_len][sessionId][data]", async () => {
      const { encodeBinaryIpcFrame, IPC_BINARY_MARKER } = await importIpc();
      const sessionId = "abc123";
      const data = Buffer.from("hello PTY");
      const frame = encodeBinaryIpcFrame(sessionId, data);

      // marker byte
      expect(frame[0]).toBe(IPC_BINARY_MARKER);
      expect(frame[0]).toBe(0x00);

      // payload length (uint32LE): 1 + 6 + 9 = 16
      const payloadLen = frame.readUInt32LE(1);
      expect(payloadLen).toBe(1 + sessionId.length + data.length);

      // sessionId length byte
      expect(frame[5]).toBe(sessionId.length);

      // sessionId bytes
      const extractedSessionId = frame.subarray(6, 6 + sessionId.length).toString("utf-8");
      expect(extractedSessionId).toBe(sessionId);

      // PTY data
      const extractedData = frame.subarray(6 + sessionId.length);
      expect(Buffer.compare(extractedData, data)).toBe(0);

      // total frame length
      expect(frame.length).toBe(1 + 4 + 1 + sessionId.length + data.length);
    });

    it("handles empty data buffer", async () => {
      const { encodeBinaryIpcFrame } = await importIpc();
      const frame = encodeBinaryIpcFrame("s1", Buffer.alloc(0));
      const payloadLen = frame.readUInt32LE(1);
      expect(payloadLen).toBe(1 + 2); // 1B sid_len + 2B "s1"
      expect(frame.length).toBe(1 + 4 + 1 + 2);
    });
  });

  describe("createIpcReader with binary frames", () => {
    it("parses binary frame via onBinaryFrame callback", async () => {
      const { createIpcReader, encodeBinaryIpcFrame } = await importIpc();
      const stream = new PassThrough();
      const jsonMsgs: unknown[] = [];
      const binaryFrames: Array<{ sessionId: string; data: Buffer }> = [];

      createIpcReader(
        stream,
        (msg) => jsonMsgs.push(msg),
        (sessionId, data) => binaryFrames.push({ sessionId, data }),
      );

      const ptyData = Buffer.from("terminal output");
      stream.write(encodeBinaryIpcFrame("sess-1", ptyData));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(binaryFrames).toHaveLength(1);
      expect(binaryFrames[0].sessionId).toBe("sess-1");
      expect(Buffer.compare(binaryFrames[0].data, ptyData)).toBe(0);
      expect(jsonMsgs).toHaveLength(0);
    });

    it("handles mixed NDJSON and binary frames in same stream", async () => {
      const { createIpcReader, serializeIpc, encodeBinaryIpcFrame } = await importIpc();
      const stream = new PassThrough();
      const jsonMsgs: unknown[] = [];
      const binaryFrames: Array<{ sessionId: string; data: Buffer }> = [];

      createIpcReader(
        stream,
        (msg) => jsonMsgs.push(msg),
        (sessionId, data) => binaryFrames.push({ sessionId, data }),
      );

      // JSON message first
      stream.write(serializeIpc({ type: "session_status_update", sessionId: "s1", state: "idle" }));
      // Binary frame
      stream.write(encodeBinaryIpcFrame("s1", Buffer.from("pty data 1")));
      // Another JSON message
      stream.write(serializeIpc({ type: "session_status_update", sessionId: "s2", state: "idle" }));
      // Another binary frame
      stream.write(encodeBinaryIpcFrame("s2", Buffer.from("pty data 2")));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(jsonMsgs).toHaveLength(2);
      expect(binaryFrames).toHaveLength(2);
      expect(binaryFrames[0].sessionId).toBe("s1");
      expect(binaryFrames[1].sessionId).toBe("s2");
    });

    it("handles binary frame split across TCP chunks", async () => {
      const { createIpcReader, encodeBinaryIpcFrame } = await importIpc();
      const stream = new PassThrough();
      const binaryFrames: Array<{ sessionId: string; data: Buffer }> = [];

      createIpcReader(
        stream,
        () => {},
        (sessionId, data) => binaryFrames.push({ sessionId, data }),
      );

      const frame = encodeBinaryIpcFrame("sess-abc", Buffer.from("split me"));
      // Split at various points across the frame header
      const split1 = 3; // middle of length field
      const split2 = 8; // middle of sessionId
      stream.write(frame.subarray(0, split1));
      stream.write(frame.subarray(split1, split2));
      stream.write(frame.subarray(split2));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(binaryFrames).toHaveLength(1);
      expect(binaryFrames[0].sessionId).toBe("sess-abc");
      expect(binaryFrames[0].data.toString()).toBe("split me");
    });

    it("handles NDJSON followed by binary frame in same chunk", async () => {
      const { createIpcReader, serializeIpc, encodeBinaryIpcFrame } = await importIpc();
      const stream = new PassThrough();
      const jsonMsgs: unknown[] = [];
      const binaryFrames: Array<{ sessionId: string; data: Buffer }> = [];

      createIpcReader(
        stream,
        (msg) => jsonMsgs.push(msg),
        (sessionId, data) => binaryFrames.push({ sessionId, data }),
      );

      // Concatenate JSON line and binary frame into a single write
      const jsonLine = serializeIpc({
        type: "session_status_update",
        sessionId: "s1",
        state: "idle",
      });
      const binaryFrame = encodeBinaryIpcFrame("s1", Buffer.from("combined"));
      const combined = Buffer.concat([Buffer.from(jsonLine), binaryFrame]);
      stream.write(combined);
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(jsonMsgs).toHaveLength(1);
      expect(binaryFrames).toHaveLength(1);
      expect(binaryFrames[0].data.toString()).toBe("combined");
    });

    it("backward compatible: works without onBinaryFrame callback", async () => {
      const { createIpcReader, serializeIpc, encodeBinaryIpcFrame } = await importIpc();
      const stream = new PassThrough();
      const jsonMsgs: unknown[] = [];

      // No onBinaryFrame callback - binary frames should be silently skipped
      createIpcReader(stream, (msg) => jsonMsgs.push(msg));

      stream.write(encodeBinaryIpcFrame("s1", Buffer.from("ignored")));
      stream.write(serializeIpc({ type: "session_status_update", sessionId: "s1", state: "idle" }));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(jsonMsgs).toHaveLength(1);
    });
  });
});

describe("Worker Protocol", () => {
  async function importIpc() {
    return await import("#src/ipc/ipc-protocol.js");
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
      stream.write(
        serializeWorkerMsg({
          type: "worker_event",
          seq: 1,
          event: { kind: "text", content: "hello" },
        }),
      );
      stream.write(
        serializeWorkerMsg({
          type: "worker_approval_request",
          requestId: "r1",
          toolName: "bash",
          input: { cmd: "ls" },
        }),
      );
      stream.write(serializeWorkerMsg({ type: "worker_exit", code: 0 }));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(4);
      expect(messages[0]).toEqual({ type: "worker_ready", pid: 12345 });
      expect(messages[1]).toEqual({
        type: "worker_event",
        seq: 1,
        event: { kind: "text", content: "hello" },
      });
      expect(messages[2]).toEqual({
        type: "worker_approval_request",
        requestId: "r1",
        toolName: "bash",
        input: { cmd: "ls" },
      });
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

    it("emits error on stream for invalid JSON, continues processing valid messages", async () => {
      const { createWorkerReader, serializeWorkerMsg } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];
      const errors: Error[] = [];
      stream.on("error", (err) => errors.push(err));

      createWorkerReader(stream, (msg) => messages.push(msg));

      stream.write("garbage-not-json\n");
      stream.write(serializeWorkerMsg({ type: "worker_stop" }));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "worker_stop" });
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/Worker message parse error/);
    });
  });

  describe("WorkerMessageSchema contract", () => {
    const WORKER_MESSAGE_SAMPLES: Array<{ type: string; payload: Record<string, unknown> }> = [
      { type: "worker_input", payload: { type: "worker_input", content: "test" } },
      { type: "worker_stop", payload: { type: "worker_stop" } },
      {
        type: "worker_approval_response",
        payload: { type: "worker_approval_response", requestId: "r1", behavior: "allow" },
      },
      {
        type: "worker_event",
        payload: { type: "worker_event", seq: 1, event: { kind: "text", data: { nested: true } } },
      },
      { type: "worker_exit", payload: { type: "worker_exit", code: 0 } },
      {
        type: "worker_approval_request",
        payload: {
          type: "worker_approval_request",
          requestId: "r2",
          toolName: "bash",
          input: { cmd: "ls", args: ["-la"] },
        },
      },
      { type: "worker_ready", payload: { type: "worker_ready", pid: 999 } },
      {
        type: "worker_claude_session_id",
        payload: { type: "worker_claude_session_id", sessionId: "cs-123" },
      },
      { type: "worker_whitelist_add", payload: { type: "worker_whitelist_add", toolName: "read" } },
    ];

    it.each(WORKER_MESSAGE_SAMPLES)("accepts valid $type message", async ({ payload }) => {
      const { WorkerMessageSchema } = await importIpc();
      const result = WorkerMessageSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it("rejects unknown worker message type", async () => {
      const { WorkerMessageSchema } = await importIpc();
      const result = WorkerMessageSchema.safeParse({ type: "worker_unknown" });
      expect(result.success).toBe(false);
    });
  });
});
