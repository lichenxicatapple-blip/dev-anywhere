import { describe, expect, it, vi } from "vitest";
import type { Socket } from "node:net";
import { IpcMessageSchema } from "#src/ipc/ipc-protocol.js";
import { terminateSessionByOwnership } from "#src/serve/session-termination.js";
import { createWritableSocketFake } from "./test-fakes.js";

function createDeps(session: unknown, options?: { terminalWrite?: ReturnType<typeof vi.fn> }) {
  const terminalSockets = new Map<string, Socket>();
  if (options?.terminalWrite) {
    terminalSockets.set("s1", createWritableSocketFake(options.terminalWrite).socket);
  }
  return {
    sessionManager: {
      getSession: vi.fn((id: string) => (id === "s1" ? session : undefined)),
      terminateSession: vi.fn(() => ({ success: true })),
    },
    workerRegistry: {
      send: vi.fn(() => true),
      delete: vi.fn(),
    },
    controlHandlers: {
      cleanup: vi.fn(),
    },
    terminalSockets,
    hostedPtyRegistry: {
      terminate: vi.fn(() => false),
    },
    agentStatusRegistry: {
      delete: vi.fn(),
    },
    broadcastSessionList: vi.fn(),
  };
}

describe("terminateSessionByOwnership", () => {
  it("detaches local-terminal PTY without stopping a worker or hosted PTY", () => {
    const terminalWrite = vi.fn();
    const deps = createDeps(
      {
        id: "s1",
        mode: "pty",
        ptyOwner: "local-terminal",
      },
      { terminalWrite },
    );

    const result = terminateSessionByOwnership(deps as never, "s1");

    expect(result).toEqual({ success: true, action: "detach_local_terminal" });
    expect(deps.sessionManager.terminateSession).toHaveBeenCalledWith("s1", {
      preserveProviderHooks: true,
    });
    expect(deps.workerRegistry.send).not.toHaveBeenCalled();
    expect(deps.hostedPtyRegistry.terminate).not.toHaveBeenCalled();
    expect(deps.controlHandlers.cleanup).toHaveBeenCalledWith("s1");
    expect(deps.terminalSockets.has("s1")).toBe(false);
    expect(IpcMessageSchema.parse(JSON.parse(terminalWrite.mock.calls[0][0].trim()))).toEqual({
      type: "pty_detach",
      sessionId: "s1",
    });
    expect(deps.broadcastSessionList).toHaveBeenCalledTimes(1);
  });

  it("terminates hosted PTY through HostedPtyRegistry", () => {
    const deps = createDeps({
      id: "s1",
      mode: "pty",
      ptyOwner: "proxy-hosted",
    });
    deps.hostedPtyRegistry.terminate.mockReturnValue(true);

    const result = terminateSessionByOwnership(deps as never, "s1");

    expect(result).toEqual({ success: true, action: "terminate_hosted_pty" });
    expect(deps.hostedPtyRegistry.terminate).toHaveBeenCalledWith("s1");
    expect(deps.sessionManager.terminateSession).not.toHaveBeenCalled();
    expect(deps.workerRegistry.send).not.toHaveBeenCalled();
    // hosted PTY 终止异步走 child.onExit → cleanupSessionResources 内部已广播，
    // 同步路径不重复广播。
    expect(deps.broadcastSessionList).not.toHaveBeenCalled();
  });

  it("terminates JSON workers through worker_stop", () => {
    const deps = createDeps({
      id: "s1",
      mode: "json",
    });

    const result = terminateSessionByOwnership(deps as never, "s1");

    expect(result).toEqual({ success: true, action: "terminate_json_worker" });
    expect(deps.workerRegistry.send).toHaveBeenCalledWith("s1", { type: "worker_stop" });
    expect(deps.workerRegistry.delete).toHaveBeenCalledWith("s1");
    expect(deps.sessionManager.terminateSession).toHaveBeenCalledWith("s1");
    expect(deps.broadcastSessionList).toHaveBeenCalledTimes(1);
  });
});
