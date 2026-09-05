import { createServer, connect, type Server, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseTerminalAdmissionRequest,
  parseTerminalAdmissionResponse,
  serializeTerminalAdmissionMessage,
  TERMINAL_ADMISSION_FRAME_MAX_BYTES,
  TERMINAL_ADMISSION_VERSION,
  type TerminalAdmissionContext,
} from "#src/ipc/terminal-admission.js";
import { TERMINAL_IPC_PROTOCOL_VERSION } from "#src/ipc/ipc-protocol.js";
import { createTerminalIpcAdmissionController } from "#src/serve/terminal-ipc-admission.js";
import {
  requestTerminalAdmission,
  TerminalAdmissionRetiredError,
} from "#src/terminal/admission-client.js";

describe("terminal IPC admission", () => {
  let server: Server | null = null;
  let destroyAdmission: (() => void) | null = null;
  const clientSockets = new Set<Socket>();
  const createTestLogger = () => ({
    warn: vi.fn((_fields: Record<string, unknown>, _message: string): void => {}),
  });

  afterEach(async () => {
    destroyAdmission?.();
    destroyAdmission = null;
    for (const socket of clientSockets) socket.destroy();
    clientSockets.clear();
    if (server?.listening) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    server = null;
  });

  async function listen(options?: {
    terminalProtocolVersion?: number;
    onAccepted?: (socket: Socket, context: TerminalAdmissionContext) => void;
    rejectionDrainMs?: number;
    logger?: ReturnType<typeof createTestLogger>;
  }): Promise<{ port: number; accepted: ReturnType<typeof vi.fn> }> {
    const accepted = vi.fn(options?.onAccepted ?? (() => {}));
    const admission = createTerminalIpcAdmissionController({
      terminalProtocolVersion: options?.terminalProtocolVersion ?? TERMINAL_IPC_PROTOCOL_VERSION,
      logger: options?.logger ?? createTestLogger(),
      rejectionDrainMs: options?.rejectionDrainMs ?? 1_000,
      handshakeTimeoutMs: 1_000,
    });
    destroyAdmission = () => admission.destroyAll();
    server = createServer({ pauseOnConnect: true }, (socket) => {
      admission.handle(socket, (context) => accepted(socket, context));
      socket.resume();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port");
    return { port: address.port, accepted };
  }

  async function open(port: number): Promise<Socket> {
    const socket = connect({ host: "127.0.0.1", port });
    clientSockets.add(socket);
    socket.once("close", () => clientSockets.delete(socket));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return socket;
  }

  it("keeps admission v1 additive when future diagnostics are present", () => {
    expect(
      parseTerminalAdmissionRequest({
        type: "terminal_admission_request",
        admissionVersion: TERMINAL_ADMISSION_VERSION,
        terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        clientKind: "local-terminal",
        futureDiagnostics: { build: "future" },
      }),
    ).toEqual({
      type: "terminal_admission_request",
      admissionVersion: TERMINAL_ADMISSION_VERSION,
      terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
      clientKind: "local-terminal",
    });
    expect(
      parseTerminalAdmissionResponse({
        type: "terminal_admission_response",
        admissionVersion: TERMINAL_ADMISSION_VERSION,
        status: "accepted",
        terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        futureCapabilities: ["diagnostics"],
      }),
    ).toEqual({
      type: "terminal_admission_response",
      admissionVersion: TERMINAL_ADMISSION_VERSION,
      status: "accepted",
      terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
    });
    expect(
      parseTerminalAdmissionResponse({
        type: "terminal_admission_response",
        admissionVersion: TERMINAL_ADMISSION_VERSION,
        status: "retired",
        terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION + 1,
        code: "TERMINAL_RUNTIME_OUTDATED",
        action: "restart_terminal",
        message: "Restart this terminal",
        futureDiagnostics: { minimumVersion: "1.2.3" },
      }),
    ).toEqual({
      type: "terminal_admission_response",
      admissionVersion: TERMINAL_ADMISSION_VERSION,
      status: "retired",
      terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION + 1,
      code: "TERMINAL_RUNTIME_OUTDATED",
      action: "restart_terminal",
      message: "Restart this terminal",
    });
  });

  it.each([
    {
      clientVersion: 1,
      daemonVersion: 2,
      code: "TERMINAL_RUNTIME_OUTDATED",
      action: "restart_terminal",
    },
    {
      clientVersion: 2,
      daemonVersion: 1,
      code: "TERMINAL_SERVICE_OUTDATED",
      action: "restart_service",
    },
  ] as const)(
    "returns a directional permanent result for protocol $clientVersion -> $daemonVersion",
    async ({ clientVersion, daemonVersion, code, action }) => {
      const { port, accepted } = await listen({ terminalProtocolVersion: daemonVersion });
      const socket = await open(port);

      const outcome = requestTerminalAdmission(socket, {
        clientKind: "local-terminal",
        terminalProtocolVersion: clientVersion,
      });

      await expect(outcome).rejects.toMatchObject({
        name: "TerminalAdmissionRetiredError",
        code,
        action,
        daemonTerminalProtocolVersion: daemonVersion,
      });
      expect(accepted).not.toHaveBeenCalled();
    },
  );

  it("accepts a terminal without publishing daemon lifecycle identity", async () => {
    const { port, accepted } = await listen();
    const socket = await open(port);

    await expect(
      requestTerminalAdmission(socket, {
        clientKind: "local-terminal",
        terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
      }),
    ).resolves.toEqual({
      type: "terminal_admission_response",
      admissionVersion: TERMINAL_ADMISSION_VERSION,
      status: "accepted",
      terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
    });
    expect(accepted).toHaveBeenCalledOnce();
  });

  it("bounds a connection that never completes admission", async () => {
    server = createServer((socket) => socket.on("data", () => {}));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port");
    const socket = await open(address.port);

    const outcome = requestTerminalAdmission(socket, {
      clientKind: "local-terminal",
      terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
      timeoutMs: 20,
    });

    await expect(outcome).rejects.toThrow("Timed out waiting for terminal admission");
    await expect(outcome).rejects.not.toBeInstanceOf(TerminalAdmissionRetiredError);
    expect(socket.destroyed).toBe(true);
  });

  it.each([
    {
      clientVersion: 1,
      daemonVersion: 2,
      code: "TERMINAL_RUNTIME_OUTDATED",
      action: "restart_terminal",
    },
    {
      clientVersion: 2,
      daemonVersion: 1,
      code: "TERMINAL_SERVICE_OUTDATED",
      action: "restart_service",
    },
  ] as const)(
    "treats an invalid accepted version $clientVersion -> $daemonVersion as permanent",
    async ({ clientVersion, daemonVersion, code, action }) => {
      server = createServer((socket) => {
        socket.once("data", () => {
          socket.end(
            serializeTerminalAdmissionMessage({
              type: "terminal_admission_response",
              admissionVersion: TERMINAL_ADMISSION_VERSION,
              status: "accepted",
              terminalProtocolVersion: daemonVersion,
            }),
          );
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing test port");
      const socket = await open(address.port);

      await expect(
        requestTerminalAdmission(socket, {
          clientKind: "local-terminal",
          terminalProtocolVersion: clientVersion,
        }),
      ).rejects.toMatchObject({ code, action, daemonTerminalProtocolVersion: daemonVersion });
    },
  );

  it("treats a recognizable but malformed admission response as permanent", async () => {
    server = createServer((socket) => {
      socket.once("data", () => {
        socket.end(
          `${JSON.stringify({
            type: "terminal_admission_response",
            admissionVersion: TERMINAL_ADMISSION_VERSION,
            status: "unknown",
            terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
          })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing test port");
    const socket = await open(address.port);

    await expect(
      requestTerminalAdmission(socket, {
        clientKind: "local-terminal",
        terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
      }),
    ).rejects.toMatchObject({
      code: "ADMISSION_RESPONSE_INVALID",
      action: "restart_service",
    });
  });

  it("hands a valid admission context to business IPC and preserves a coalesced frame once", async () => {
    let businessBytes = Buffer.alloc(0);
    const { port, accepted } = await listen({
      onAccepted: (socket) => {
        socket.on("data", (chunk: Buffer) => {
          businessBytes = Buffer.concat([businessBytes, chunk]);
        });
      },
    });
    const socket = await open(port);
    const businessFrame = Buffer.from(
      `${JSON.stringify({ type: "future_business_frame", body: "x".repeat(20_000) })}\n`,
    );
    const admissionFrame = Buffer.from(
      serializeTerminalAdmissionMessage({
        type: "terminal_admission_request",
        admissionVersion: TERMINAL_ADMISSION_VERSION,
        terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        clientKind: "local-terminal",
      }),
    );

    socket.write(Buffer.concat([admissionFrame, businessFrame]));

    await vi.waitFor(() => expect(businessBytes.length).toBe(businessFrame.length));
    expect(businessBytes.equals(businessFrame)).toBe(true);
    expect(accepted).toHaveBeenCalledOnce();
    expect(accepted.mock.calls[0]?.[1]).toEqual({ clientKind: "local-terminal" });
  });

  it("bounds an unterminated first frame without admitting or repeatedly logging it", async () => {
    const logger = createTestLogger();
    const { port, accepted } = await listen({ logger });
    const socket = await open(port);

    socket.write(Buffer.alloc(TERMINAL_ADMISSION_FRAME_MAX_BYTES + 1, 0x78));

    await vi.waitFor(() =>
      expect(logger.warn).toHaveBeenCalledWith(
        { maxFrameBytes: TERMINAL_ADMISSION_FRAME_MAX_BYTES },
        "Terminal admission first frame exceeded the byte limit",
      ),
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(accepted).not.toHaveBeenCalled();
  });

  it("rejects a worker admission that does not bind a session id", async () => {
    const { port, accepted } = await listen();
    const socket = await open(port);
    const response = new Promise<Record<string, unknown>>((resolve) => {
      socket.once("data", (chunk) => resolve(JSON.parse(String(chunk))));
    });

    socket.write(
      serializeTerminalAdmissionMessage({
        type: "terminal_admission_request",
        admissionVersion: TERMINAL_ADMISSION_VERSION,
        terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
        clientKind: "terminal-worker",
      }),
    );

    await expect(response).resolves.toMatchObject({
      status: "retired",
      code: "ADMISSION_REQUEST_INVALID",
      action: "restart_terminal",
    });
    expect(accepted).not.toHaveBeenCalled();
  });

  it("retires an unversioned reconnect with the control its client already understands", async () => {
    const { port, accepted } = await listen();
    let connections = 0;
    let remoteDetached = false;

    const connectLikePreAdmissionTerminal = (): void => {
      const socket = connect({ host: "127.0.0.1", port });
      clientSockets.add(socket);
      connections += 1;
      let buffer = "";
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({
            type: "session_create_request",
            mode: "pty",
            provider: "kimi",
            cwd: "/tmp/project",
            name: "project",
            pid: 4242,
            sessionId: "old-agent-session",
          })}\n`,
        );
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        for (const line of buffer.split("\n").slice(0, -1)) {
          const message = JSON.parse(line) as { type?: string; sessionId?: string };
          if (message.type === "pty_detach" && message.sessionId === "old-agent-session") {
            remoteDetached = true;
            socket.end();
          }
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      });
      socket.once("close", () => {
        clientSockets.delete(socket);
        if (!remoteDetached) connectLikePreAdmissionTerminal();
      });
    };

    // The historical failure could fork several reconnect loops in one process.  They share the
    // same remote-detached flag, so retiring any one loop must make every sibling close without
    // opening a replacement connection.
    for (let index = 0; index < 4; index += 1) connectLikePreAdmissionTerminal();

    await vi.waitFor(() => expect(remoteDetached).toBe(true));
    await delay(25);
    expect(connections).toBe(4);
    expect(accepted).not.toHaveBeenCalled();
  });

  it.each([
    [TERMINAL_IPC_PROTOCOL_VERSION, TERMINAL_IPC_PROTOCOL_VERSION, "same business version"],
    [TERMINAL_IPC_PROTOCOL_VERSION + 1, TERMINAL_IPC_PROTOCOL_VERSION, "older business version"],
  ])(
    "retires a versioned agent reconnect without admitting its daemon-v%s/client-v%s frame (%s)",
    async (daemonVersion, clientVersion) => {
      const { port, accepted } = await listen({ terminalProtocolVersion: daemonVersion });
      const socket = await open(port);
      const response = new Promise<string>((resolve) =>
        socket.once("data", (chunk) => resolve(String(chunk))),
      );

      socket.write(
        `${JSON.stringify({
          type: "session_create_request",
          protocolVersion: clientVersion,
          kind: "agent",
          mode: "pty",
          provider: "codex",
          cwd: "/tmp/project",
          pid: 5252,
          sessionId: "versioned-agent-session",
        })}\n`,
      );

      await expect(response).resolves.toBe(
        `${JSON.stringify({ type: "pty_detach", sessionId: "versioned-agent-session" })}\n`,
      );
      expect(accepted).not.toHaveBeenCalled();
      socket.end();
    },
  );

  it("terminates a pre-admission shell worker instead of triggering its detach reconnect path", async () => {
    const { port, accepted } = await listen();
    let connections = 0;
    let exiting = false;

    const connectLikePreAdmissionWorker = (): void => {
      const socket = connect({ host: "127.0.0.1", port });
      clientSockets.add(socket);
      connections += 1;
      let buffer = "";
      socket.once("connect", () => {
        socket.write(
          `${JSON.stringify({
            type: "session_create_request",
            protocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
            kind: "terminal",
            mode: "pty",
            provider: "claude",
            cwd: "/tmp/project",
            pid: 6262,
            sessionId: "old-worker-session",
          })}\n`,
        );
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        for (const line of buffer.split("\n").slice(0, -1)) {
          const message = JSON.parse(line) as { type?: string };
          if (message.type === "pty_terminate") {
            exiting = true;
            socket.end();
          } else if (message.type === "pty_detach") {
            // The old worker ended this socket for detach but left `exiting` false, so its close
            // handler opened another connection.  This branch makes that historical failure mode
            // part of the harness rather than merely asserting a serialized object.
            socket.end();
          }
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      });
      socket.once("close", () => {
        clientSockets.delete(socket);
        if (!exiting) connectLikePreAdmissionWorker();
      });
    };

    connectLikePreAdmissionWorker();

    await vi.waitFor(() => expect(exiting).toBe(true));
    await delay(25);
    expect(connections).toBe(1);
    expect(accepted).not.toHaveBeenCalled();
  });

  it("terminates an unversioned shell worker using its historical control frame", async () => {
    const { port, accepted } = await listen();
    const socket = await open(port);
    const response = new Promise<string>((resolve) =>
      socket.once("data", (chunk) => resolve(String(chunk))),
    );

    socket.write(
      `${JSON.stringify({
        type: "session_create_request",
        mode: "pty",
        provider: "claude",
        cwd: "/tmp/project",
        name: "project",
        pid: 7272,
        sessionId: "unversioned-worker-session",
        kind: "terminal",
      })}\n`,
    );

    await expect(response).resolves.toBe(
      `${JSON.stringify({ type: "pty_terminate", sessionId: "unversioned-worker-session" })}\n`,
    );
    expect(accepted).not.toHaveBeenCalled();
    socket.end();
  });

  it.each(["", '{"type":"terminal_admission_response"'])(
    "keeps an incomplete response retryable without inferring the daemon version (%j)",
    async (response) => {
      server = createServer((socket) => socket.once("data", () => socket.end(response)));
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing test port");
      const socket = await open(address.port);

      const outcome = requestTerminalAdmission(socket, {
        clientKind: "local-terminal",
        terminalProtocolVersion: TERMINAL_IPC_PROTOCOL_VERSION,
      });

      await expect(outcome).rejects.toThrow("Serve ended before completing terminal admission");
      await expect(outcome).rejects.not.toBeInstanceOf(TerminalAdmissionRetiredError);
      expect(socket.destroyed).toBe(true);
    },
  );

  it("aggregates repeated invalid-first-frame warnings and flushes the suppressed count", async () => {
    const logger = createTestLogger();
    const { port } = await listen({ logger });

    for (let index = 0; index < 3; index += 1) {
      const socket = await open(port);
      socket.write("not-json\n");
    }
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());
    await delay(25);

    destroyAdmission?.();
    destroyAdmission = null;

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[1]?.[0]).toMatchObject({ suppressedSinceLastLog: 2 });
  });
});
