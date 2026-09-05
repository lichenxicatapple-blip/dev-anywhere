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
      terminateProcess: vi.fn(() => true),
    },
    terminalSockets,
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
    expect(deps.terminalSockets.has("s1")).toBe(false);
    expect(IpcMessageSchema.parse(JSON.parse(terminalWrite.mock.calls[0][0].trim()))).toEqual({
      type: "pty_detach",
      sessionId: "s1",
    });
  });

  it("terminates pure terminal workers instead of detaching their remote view", () => {
    const terminalWrite = vi.fn();
    const deps = createDeps(
      {
        id: "s1",
        kind: "terminal",
        mode: "pty",
        ptyOwner: "proxy-hosted",
      },
      { terminalWrite },
    );

    const result = terminateSessionByOwnership(deps as never, "s1");

    expect(result).toEqual({ success: true, action: "terminate_terminal_worker" });
    expect(deps.sessionManager.terminateSession).toHaveBeenCalledWith("s1");
    expect(deps.terminalSockets.has("s1")).toBe(false);
    expect(IpcMessageSchema.parse(JSON.parse(terminalWrite.mock.calls[0][0].trim()))).toEqual({
      type: "pty_terminate",
      sessionId: "s1",
    });
  });

  it("does not signal an unverified persisted terminal-worker PID", () => {
    const deps = {
      ...createDeps({
        id: "s1",
        kind: "terminal",
        mode: "pty",
        provider: "claude",
        ptyOwner: "proxy-hosted",
        cwd: "/tmp",
        pid: 4242,
      }),
      isManagedSessionProcess: vi.fn(() => false),
    };
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = terminateSessionByOwnership(deps as never, "s1");

    expect(result).toEqual({ success: true, action: "terminate_terminal_worker" });
    expect(deps.isManagedSessionProcess).toHaveBeenCalledWith(4242, {
      id: "s1",
      kind: "terminal",
      mode: "pty",
      provider: "claude",
      ptyOwner: "proxy-hosted",
    });
    expect(kill).not.toHaveBeenCalled();
    expect(deps.sessionManager.terminateSession).toHaveBeenCalledWith("s1");
    kill.mockRestore();
  });

  it("signals a terminal-worker PID only after exact managed-process verification", () => {
    const deps = {
      ...createDeps({
        id: "s1",
        kind: "terminal",
        mode: "pty",
        provider: "claude",
        ptyOwner: "proxy-hosted",
        cwd: "/tmp",
        pid: 4242,
      }),
      isManagedSessionProcess: vi.fn(() => true),
    };
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    const result = terminateSessionByOwnership(deps as never, "s1");

    expect(result).toEqual({ success: true, action: "terminate_terminal_worker" });
    expect(kill).toHaveBeenCalledWith(4242, "SIGTERM");
    expect(deps.sessionManager.terminateSession).toHaveBeenCalledWith("s1");
    kill.mockRestore();
  });

  it("terminates hosted Agent PTYs through their worker socket", () => {
    const terminalWrite = vi.fn();
    const deps = createDeps(
      { id: "s1", kind: "agent", mode: "pty", provider: "kimi", ptyOwner: "proxy-hosted" },
      { terminalWrite },
    );
    expect(terminateSessionByOwnership(deps as never, "s1")).toEqual({
      success: true,
      action: "terminate_terminal_worker",
    });
    expect(JSON.parse(terminalWrite.mock.calls[0][0])).toEqual({
      type: "pty_terminate",
      sessionId: "s1",
    });
    expect(deps.sessionManager.terminateSession).toHaveBeenCalledWith("s1");
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
    expect(deps.workerRegistry.terminateProcess).not.toHaveBeenCalled();
    expect(deps.sessionManager.terminateSession).toHaveBeenCalledWith("s1");
  });

  it("kills a JSON worker when its control channel is already unavailable", () => {
    const deps = createDeps({
      id: "s1",
      mode: "json",
    });
    deps.workerRegistry.send.mockReturnValue(false);

    const result = terminateSessionByOwnership(deps as never, "s1");

    expect(result).toEqual({ success: true, action: "terminate_json_worker" });
    expect(deps.workerRegistry.send).toHaveBeenCalledWith("s1", { type: "worker_stop" });
    expect(deps.workerRegistry.delete).not.toHaveBeenCalled();
    expect(deps.workerRegistry.terminateProcess).toHaveBeenCalledWith("s1");
    expect(deps.sessionManager.terminateSession).toHaveBeenCalledWith("s1");
  });
});
