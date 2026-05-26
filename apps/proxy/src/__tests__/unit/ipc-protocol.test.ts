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
        provider: "claude" as const,
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

    it("accepts a Codex PTY session create request", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "session_create_request",
        mode: "pty",
        provider: "codex",
        cwd: "/tmp/test",
        pid: 12345,
      });

      expect(result.success).toBe(true);
    });

    it("accepts PTY subscribe and snapshot requestId round-trip fields", async () => {
      const { IpcMessageSchema } = await importIpc();

      expect(
        IpcMessageSchema.safeParse({
          type: "pty_subscribe",
          sessionId: "sess-1",
          requestId: "pty-snapshot-1",
        }).success,
      ).toBe(true);
      expect(
        IpcMessageSchema.safeParse({
          type: "pty_snapshot",
          sessionId: "sess-1",
          cols: 80,
          rows: 24,
          data: "snapshot",
          outputSeq: 1,
          requestId: "pty-snapshot-1",
        }).success,
      ).toBe(true);
    });

    it("accepts PTY detach messages", async () => {
      const { IpcMessageSchema } = await importIpc();

      expect(
        IpcMessageSchema.safeParse({
          type: "pty_detach",
          sessionId: "sess-1",
        }).success,
      ).toBe(true);
    });

    it("accepts service status responses with relay naming", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "service_status_response",
        config: {
          profile: "local",
          relayName: "local",
          relayNameSource: "profile",
          relayUrl: "ws://localhost:3100",
          relayUrlSource: "file",
          relayTokenSource: "none",
          hookPort: 17978,
          hookPortSource: "default",
        },
        relay: null,
        sessions: [],
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
          provider: "claude",
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
        provider: "claude",
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
          provider: "claude",
          cwd: "/tmp/test",
          pid: 12345,
        }) + "\n",
      );
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(2);
    });

    it("calls onProtocolError for invalid JSON, continues processing valid messages, does NOT emit stream error", async () => {
      const { createIpcReader } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];
      const protocolErrors: Array<{ msg: string; line: string }> = [];
      const streamErrors: Error[] = [];
      stream.on("error", (err) => streamErrors.push(err));

      createIpcReader(
        stream,
        (msg) => messages.push(msg),
        undefined,
        (err, line) => protocolErrors.push({ msg: err.message, line }),
      );

      stream.write("not-valid-json\n");
      stream.write(
        JSON.stringify({ type: "session_status_update", sessionId: "s1", state: "idle" }) + "\n",
      );
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      // 单条坏行不应升级为传输层错误（避免 socket.on("error") → onDisconnect 把整个 session 推 ERROR）。
      expect(messages).toHaveLength(1);
      expect(streamErrors).toHaveLength(0);
      expect(protocolErrors).toHaveLength(1);
      expect(protocolErrors[0]!.msg).toMatch(/IPC message parse error/);
      expect(protocolErrors[0]!.line).toBe("not-valid-json");
    });

    it("calls onProtocolError for schema-invalid messages without breaking the reader", async () => {
      const { createIpcReader } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];
      const protocolErrors: Error[] = [];
      const streamErrors: Error[] = [];
      stream.on("error", (err) => streamErrors.push(err));

      createIpcReader(
        stream,
        (msg) => messages.push(msg),
        undefined,
        (err) => protocolErrors.push(err),
      );

      stream.write(JSON.stringify({ type: "totally_unknown_future_message" }) + "\n");
      stream.write(
        JSON.stringify({ type: "session_status_update", sessionId: "s1", state: "idle" }) + "\n",
      );
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(streamErrors).toHaveLength(0);
      expect(protocolErrors).toHaveLength(1);
      expect(protocolErrors[0]!.message).toMatch(/IPC message validation failed/);
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
    it("produces correct binary frame format: [0x00][4B len LE][1B sessionId_len][sessionId][4B outputSeq][data]", async () => {
      const { encodeBinaryIpcFrame, IPC_BINARY_MARKER } = await importIpc();
      const sessionId = "abc123";
      const data = Buffer.from("hello PTY");
      const frame = encodeBinaryIpcFrame(sessionId, data, 42);

      // marker byte
      expect(frame[0]).toBe(IPC_BINARY_MARKER);
      expect(frame[0]).toBe(0x00);

      // payload length (uint32LE): 1 + 6 + 4 + 9 = 20
      const payloadLen = frame.readUInt32LE(1);
      expect(payloadLen).toBe(1 + sessionId.length + 4 + data.length);

      // sessionId length byte
      expect(frame[5]).toBe(sessionId.length);

      // sessionId bytes
      const extractedSessionId = frame.subarray(6, 6 + sessionId.length).toString("utf-8");
      expect(extractedSessionId).toBe(sessionId);

      // output sequence
      const extractedOutputSeq = frame.readUInt32LE(6 + sessionId.length);
      expect(extractedOutputSeq).toBe(42);

      // PTY data
      const extractedData = frame.subarray(6 + sessionId.length + 4);
      expect(Buffer.compare(extractedData, data)).toBe(0);

      // total frame length
      expect(frame.length).toBe(1 + 4 + 1 + sessionId.length + 4 + data.length);
    });

    it("handles empty data buffer", async () => {
      const { encodeBinaryIpcFrame } = await importIpc();
      const frame = encodeBinaryIpcFrame("s1", Buffer.alloc(0), 1);
      const payloadLen = frame.readUInt32LE(1);
      expect(payloadLen).toBe(1 + 2 + 4); // 1B sid_len + 2B "s1" + 4B outputSeq
      expect(frame.length).toBe(1 + 4 + 1 + 2 + 4);
    });
  });

  describe("createIpcReader with binary frames", () => {
    it("parses binary frame via onBinaryFrame callback", async () => {
      const { createIpcReader, encodeBinaryIpcFrame } = await importIpc();
      const stream = new PassThrough();
      const jsonMsgs: unknown[] = [];
      const binaryFrames: Array<{ sessionId: string; data: Buffer; outputSeq: number }> = [];

      createIpcReader(
        stream,
        (msg) => jsonMsgs.push(msg),
        (sessionId, data, outputSeq) => binaryFrames.push({ sessionId, data, outputSeq }),
      );

      const ptyData = Buffer.from("terminal output");
      stream.write(encodeBinaryIpcFrame("sess-1", ptyData, 7));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(binaryFrames).toHaveLength(1);
      expect(binaryFrames[0].sessionId).toBe("sess-1");
      expect(Buffer.compare(binaryFrames[0].data, ptyData)).toBe(0);
      expect(binaryFrames[0].outputSeq).toBe(7);
      expect(jsonMsgs).toHaveLength(0);
    });

    it("handles mixed NDJSON and binary frames in same stream", async () => {
      const { createIpcReader, serializeIpc, encodeBinaryIpcFrame } = await importIpc();
      const stream = new PassThrough();
      const jsonMsgs: unknown[] = [];
      const binaryFrames: Array<{ sessionId: string; data: Buffer; outputSeq: number }> = [];

      createIpcReader(
        stream,
        (msg) => jsonMsgs.push(msg),
        (sessionId, data, outputSeq) => binaryFrames.push({ sessionId, data, outputSeq }),
      );

      // JSON message first
      stream.write(serializeIpc({ type: "session_status_update", sessionId: "s1", state: "idle" }));
      // Binary frame
      stream.write(encodeBinaryIpcFrame("s1", Buffer.from("pty data 1"), 1));
      // Another JSON message
      stream.write(serializeIpc({ type: "session_status_update", sessionId: "s2", state: "idle" }));
      // Another binary frame
      stream.write(encodeBinaryIpcFrame("s2", Buffer.from("pty data 2"), 2));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(jsonMsgs).toHaveLength(2);
      expect(binaryFrames).toHaveLength(2);
      expect(binaryFrames[0].sessionId).toBe("s1");
      expect(binaryFrames[0].outputSeq).toBe(1);
      expect(binaryFrames[1].sessionId).toBe("s2");
      expect(binaryFrames[1].outputSeq).toBe(2);
    });

    it("handles binary frame split across TCP chunks", async () => {
      const { createIpcReader, encodeBinaryIpcFrame } = await importIpc();
      const stream = new PassThrough();
      const binaryFrames: Array<{ sessionId: string; data: Buffer; outputSeq: number }> = [];

      createIpcReader(
        stream,
        () => {},
        (sessionId, data, outputSeq) => binaryFrames.push({ sessionId, data, outputSeq }),
      );

      const frame = encodeBinaryIpcFrame("sess-abc", Buffer.from("split me"), 3);
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
      expect(binaryFrames[0].outputSeq).toBe(3);
    });

    it("handles NDJSON followed by binary frame in same chunk", async () => {
      const { createIpcReader, serializeIpc, encodeBinaryIpcFrame } = await importIpc();
      const stream = new PassThrough();
      const jsonMsgs: unknown[] = [];
      const binaryFrames: Array<{ sessionId: string; data: Buffer; outputSeq: number }> = [];

      createIpcReader(
        stream,
        (msg) => jsonMsgs.push(msg),
        (sessionId, data, outputSeq) => binaryFrames.push({ sessionId, data, outputSeq }),
      );

      // Concatenate JSON line and binary frame into a single write
      const jsonLine = serializeIpc({
        type: "session_status_update",
        sessionId: "s1",
        state: "idle",
      });
      const binaryFrame = encodeBinaryIpcFrame("s1", Buffer.from("combined"), 4);
      const combined = Buffer.concat([Buffer.from(jsonLine), binaryFrame]);
      stream.write(combined);
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(jsonMsgs).toHaveLength(1);
      expect(binaryFrames).toHaveLength(1);
      expect(binaryFrames[0].data.toString()).toBe("combined");
      expect(binaryFrames[0].outputSeq).toBe(4);
    });

    it("skips binary frames when no binary callback is registered", async () => {
      const { createIpcReader, serializeIpc, encodeBinaryIpcFrame } = await importIpc();
      const stream = new PassThrough();
      const jsonMsgs: unknown[] = [];

      // No onBinaryFrame callback - binary frames should be silently skipped
      createIpcReader(stream, (msg) => jsonMsgs.push(msg));

      stream.write(encodeBinaryIpcFrame("s1", Buffer.from("ignored"), 1));
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

    it("calls onProtocolError for invalid JSON, continues processing valid messages, does NOT emit stream error", async () => {
      const { createWorkerReader, serializeWorkerMsg } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];
      const protocolErrors: Array<{ msg: string; line: string }> = [];
      const streamErrors: Error[] = [];
      stream.on("error", (err) => streamErrors.push(err));

      createWorkerReader(
        stream,
        (msg) => messages.push(msg),
        (err, line) => protocolErrors.push({ msg: err.message, line }),
      );

      stream.write("garbage-not-json\n");
      stream.write(serializeWorkerMsg({ type: "worker_stop" }));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "worker_stop" });
      expect(streamErrors).toHaveLength(0);
      expect(protocolErrors).toHaveLength(1);
      expect(protocolErrors[0]!.msg).toMatch(/Worker message parse error/);
    });

    it("calls onProtocolError for schema-invalid worker messages without breaking the reader", async () => {
      const { createWorkerReader, serializeWorkerMsg } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];
      const protocolErrors: Error[] = [];
      const streamErrors: Error[] = [];
      stream.on("error", (err) => streamErrors.push(err));

      createWorkerReader(
        stream,
        (msg) => messages.push(msg),
        (err) => protocolErrors.push(err),
      );

      // 模拟未来 Claude/Codex CLI 加新事件类型，旧版 dev-anywhere 不识别
      stream.write(JSON.stringify({ type: "worker_telemetry_v2" }) + "\n");
      stream.write(serializeWorkerMsg({ type: "worker_stop" }));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "worker_stop" });
      expect(streamErrors).toHaveLength(0);
      expect(protocolErrors).toHaveLength(1);
      expect(protocolErrors[0]!.message).toMatch(/Worker message validation failed/);
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
      {
        type: "worker_native_session_id",
        payload: { type: "worker_native_session_id", provider: "codex", sessionId: "cx-123" },
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
