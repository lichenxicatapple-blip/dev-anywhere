import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";

describe("IPC Protocol", () => {
  async function importIpc() {
    return await import("../ipc-protocol.js");
  }

  describe("serializeIpc", () => {
    it("produces valid JSON terminated with newline", async () => {
      const { serializeIpc } = await importIpc();
      const msg = { type: "heartbeat" as const };
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

      stream.write(serializeIpc({ type: "heartbeat" }));
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
      expect(messages[0]).toEqual({ type: "heartbeat" });
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
      const fullMsg = JSON.stringify({ type: "heartbeat" }) + "\n";
      const splitPoint = Math.floor(fullMsg.length / 2);
      stream.write(fullMsg.slice(0, splitPoint));
      stream.write(fullMsg.slice(splitPoint));
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({ type: "heartbeat" });
    });

    it("skips empty lines", async () => {
      const { createIpcReader } = await importIpc();
      const stream = new PassThrough();
      const messages: unknown[] = [];

      createIpcReader(stream, (msg) => messages.push(msg));

      stream.write(JSON.stringify({ type: "heartbeat" }) + "\n");
      stream.write("\n");
      stream.write(JSON.stringify({ type: "heartbeat_ack" }) + "\n");
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
      stream.write(JSON.stringify({ type: "heartbeat" }) + "\n");
      stream.end();

      await new Promise((r) => setTimeout(r, 50));

      expect(messages).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe("IpcMessageSchema", () => {
    it("validates session_create_request", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "session_create_request",
        name: "my-session",
        mode: "pty",
      });
      expect(result.success).toBe(true);
    });

    it("validates session_create_response", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "session_create_response",
        sessionId: "abc123",
      });
      expect(result.success).toBe(true);
    });

    it("validates session_list_request", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "session_list_request",
      });
      expect(result.success).toBe(true);
    });

    it("validates session_list_response", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "session_list_response",
        sessions: [
          {
            id: "s1",
            mode: "pty",
            state: "idle",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("validates session_terminate_request", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "session_terminate_request",
        sessionId: "abc",
      });
      expect(result.success).toBe(true);
    });

    it("validates session_terminate_response", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "session_terminate_response",
        sessionId: "abc",
        success: true,
      });
      expect(result.success).toBe(true);
    });

    it("validates pty_register", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "pty_register",
        sessionId: "s1",
      });
      expect(result.success).toBe(true);
    });

    it("validates pty_deregister", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "pty_deregister",
        sessionId: "s1",
      });
      expect(result.success).toBe(true);
    });

    it("validates pty_output", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "pty_output",
        sessionId: "s1",
        data: "hello world",
      });
      expect(result.success).toBe(true);
    });

    it("validates pty_input", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "pty_input",
        sessionId: "s1",
        data: "user input",
      });
      expect(result.success).toBe(true);
    });

    it("validates heartbeat with optional sessionId", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result1 = IpcMessageSchema.safeParse({ type: "heartbeat" });
      expect(result1.success).toBe(true);

      const result2 = IpcMessageSchema.safeParse({
        type: "heartbeat",
        sessionId: "s1",
      });
      expect(result2.success).toBe(true);
    });

    it("validates heartbeat_ack", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({ type: "heartbeat_ack" });
      expect(result.success).toBe(true);
    });

    it("validates session_status_update", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "session_status_update",
        sessionId: "s1",
        state: "working",
      });
      expect(result.success).toBe(true);
    });

    it("validates error message", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "error",
        message: "something went wrong",
        code: "ERR_TIMEOUT",
      });
      expect(result.success).toBe(true);
    });

    it("rejects unknown message type", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({
        type: "unknown_type",
      });
      expect(result.success).toBe(false);
    });
  });
});
