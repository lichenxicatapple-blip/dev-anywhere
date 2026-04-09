import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";

describe("IPC Protocol", () => {
  async function importIpc() {
    return await import("#src/ipc-protocol.js");
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
    it("rejects unknown message type", async () => {
      const { IpcMessageSchema } = await importIpc();
      const result = IpcMessageSchema.safeParse({ type: "unknown_type" });
      expect(result.success).toBe(false);
    });
  });
});
