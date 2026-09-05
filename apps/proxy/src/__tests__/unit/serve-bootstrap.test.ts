import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { IpcProtocolError, waitForMessage } from "#src/terminal/serve-bootstrap.js";
import { serializeIpc, TERMINAL_IPC_PROTOCOL_VERSION } from "#src/ipc/ipc-protocol.js";

describe("terminal IPC response waiter", () => {
  it("resolves a current-protocol response", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const response = waitForMessage(socket, "session_create_response");

    socket.write(
      serializeIpc({
        type: "session_create_response",
        success: true,
        protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        sessionId: "session-1",
      }),
    );

    await expect(response).resolves.toMatchObject({ success: true, sessionId: "session-1" });
    socket.destroy();
  });

  it.each([
    ["missing", undefined],
    ["mismatched", TERMINAL_IPC_PROTOCOL_VERSION + 1],
  ])(
    "rejects a %s protocol version without waiting for a retry timeout",
    async (_label, version) => {
      const socket = new PassThrough() as unknown as Socket;
      const response = waitForMessage(socket, "session_create_response");

      socket.write(
        `${JSON.stringify({
          type: "session_create_response",
          success: true,
          ...(version === undefined ? {} : { protocolVersion: version }),
          sessionId: "session-1",
        })}\n`,
      );

      await expect(response).rejects.toBeInstanceOf(IpcProtocolError);
      socket.destroy();
    },
  );

  it("destroys a socket whose response handshake times out", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const response = waitForMessage(socket, "session_create_response", 5);

    await expect(response).rejects.toThrow("Timeout waiting for session_create_response");
    expect(socket.destroyed).toBe(true);
  });

  it("rejects immediately when the socket closes during a response handshake", async () => {
    const socket = new PassThrough() as unknown as Socket;
    const response = waitForMessage(socket, "session_create_response", 10_000);

    socket.destroy();

    await expect(response).rejects.toThrow("Socket closed waiting for session_create_response");
  });
});
