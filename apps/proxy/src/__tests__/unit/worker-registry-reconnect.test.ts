import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import { localIpcEndpointPath } from "#src/common/paths.js";
import type { SessionManager } from "#src/serve/session-manager.js";
import { WorkerRegistry } from "#src/serve/worker-registry.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import {
  createJsonObserverFake,
  createRelayConnectionFake,
  createSessionManagerFake,
  serializeWorkerHandshake,
} from "./test-fakes.js";

const isManagedSessionProcessMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("#src/common/managed-session-process.js", () => ({
  isManagedSessionProcess: isManagedSessionProcessMock,
}));

const paths = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return {
    dataDir: mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "da-worker-")),
  };
});

vi.mock("#src/common/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/common/paths.js")>();
  return {
    ...actual,
    DATA_DIR: paths.dataDir,
    sessionPaths: (sessionId: string) => {
      const dir = `${paths.dataDir}/${sessionId}`;
      return { dir, workerSock: actual.localIpcEndpointPath(`${dir}/worker.sock`) };
    },
  };
});

describe("WorkerRegistry reconnect protocol handshake", () => {
  let server: Server | null;
  let acceptedSocket: Socket | null;
  let registry: WorkerRegistry | null;
  const sessionId = "persisted-json-session";
  const sessionDir = `${paths.dataDir}/${sessionId}`;
  const socketPath = localIpcEndpointPath(`${sessionDir}/worker.sock`);

  beforeEach(() => {
    rmSync(paths.dataDir, { recursive: true, force: true });
    mkdirSync(sessionDir, { recursive: true });
    acceptedSocket = null;
    registry = null;
    server = null;
    isManagedSessionProcessMock.mockReset();
    isManagedSessionProcessMock.mockReturnValue(false);
  });

  afterEach(async () => {
    registry?.destroyAll();
    acceptedSocket?.destroy();
    const activeServer = server;
    if (activeServer) await new Promise<void>((resolve) => activeServer.close(() => resolve()));
    rmSync(paths.dataDir, { recursive: true, force: true });
  });

  async function listen(onConnection?: (socket: Socket) => void): Promise<void> {
    const nextServer = createServer((socket) => {
      acceptedSocket = socket;
      onConnection?.(socket);
    });
    server = nextServer;
    await new Promise<void>((resolve) => nextServer.listen(socketPath, resolve));
  }

  function createRegistry(sessionManager: SessionManager): WorkerRegistry {
    return new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
    });
  }

  it("reconnects a worker that reports the current protocol version", async () => {
    await listen((socket) => {
      socket.write(
        serializeWorkerHandshake(sessionId, 1, "claude", {
          type: "worker_ready",
          pid: 12345,
        }),
      );
    });
    const sessionManager = createSessionManagerFake([
      {
        id: sessionId,
        kind: "agent",
        mode: "json",
        provider: "claude",
        state: "idle",
        createdAt: 1,
        updatedAt: 1,
        cwd: "/tmp",
        pid: 1,
      },
    ]);
    registry = createRegistry(sessionManager);

    await registry.reconnectAll();

    expect(registry.has(sessionId)).toBe(true);
    expect(sessionManager.terminateSession).not.toHaveBeenCalled();
  });

  it("terminates a persisted worker that never provides a protocol hello", async () => {
    await listen();
    let active = true;
    const session = {
      id: sessionId,
      kind: "agent" as const,
      mode: "json" as const,
      provider: "claude" as const,
      state: "idle" as const,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/tmp",
      pid: 12345,
    };
    const terminateSession = vi.fn(() => {
      active = false;
      return { success: true };
    });
    const sessionManager = {
      getSession: vi.fn(() => (active ? session : undefined)),
      listSessions: vi.fn(() => (active ? [session] : [])),
      terminateSession,
    } as unknown as SessionManager;
    registry = createRegistry(sessionManager);

    await registry.reconnectAll();

    expect(terminateSession).toHaveBeenCalledWith(sessionId);
    expect(registry.has(sessionId)).toBe(false);
  });

  it("removes a persisted JSON session when no worker socket exists", async () => {
    rmSync(paths.dataDir, { recursive: true, force: true });
    const sessionManager = createSessionManagerFake([
      {
        id: sessionId,
        kind: "agent",
        mode: "json",
        provider: "kimi",
        state: "idle",
        createdAt: 1,
        updatedAt: 1,
        pid: 4242,
        cwd: "/tmp/project",
      },
    ]);
    vi.mocked(sessionManager.terminateSession).mockReturnValue({ success: true, pid: 4242 });
    registry = createRegistry(sessionManager);

    await registry.reconnectAll();

    expect(sessionManager.terminateSession).toHaveBeenCalledOnce();
    expect(sessionManager.terminateSession).toHaveBeenCalledWith(sessionId);
    expect(isManagedSessionProcessMock).toHaveBeenCalledWith(4242, {
      id: sessionId,
      mode: "json",
      provider: "kimi",
      workerSocketPath: socketPath,
    });
    expect(registry.has(sessionId)).toBe(false);
  });

  it("terminates a verified orphan worker instead of only disconnecting its socket", async () => {
    await listen((socket) => {
      socket.write(
        serializeWorkerHandshake(sessionId, 4242, "kimi", {
          type: "worker_ready",
          pid: 5252,
        }),
      );
    });
    isManagedSessionProcessMock.mockReturnValue(true);
    const terminateManagedSession = vi.fn();
    const sessionManager = createSessionManagerFake([]);
    registry = new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
      terminateManagedSession,
    });

    await registry.reconnectAll();

    expect(isManagedSessionProcessMock).toHaveBeenCalledWith(4242, {
      id: sessionId,
      mode: "json",
      provider: "kimi",
      workerSocketPath: socketPath,
    });
    expect(terminateManagedSession).toHaveBeenCalledWith(4242);
    expect(sessionManager.terminateSession).not.toHaveBeenCalled();
  });
});
