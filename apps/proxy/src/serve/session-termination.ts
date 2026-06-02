import type { Socket } from "node:net";
import { serviceLogger } from "../common/logger.js";
import { serializeIpc } from "../ipc/ipc-protocol.js";
import type { AgentStatusRegistry } from "./agent-status-registry.js";
import type { ControlMessageHandlers } from "./handlers/control-messages.js";
import type { HostedPtyRegistry } from "./hosted-pty-registry.js";
import type { SessionManager } from "./session-manager.js";
import type { WorkerRegistry } from "./worker-registry.js";

type SessionTerminationAction =
  | "detach_local_terminal"
  | "terminate_terminal_worker"
  | "terminate_hosted_pty"
  | "terminate_json_worker"
  | "not_found";

interface TerminateSessionDeps {
  sessionManager: SessionManager;
  workerRegistry: WorkerRegistry;
  controlHandlers: ControlMessageHandlers;
  terminalSockets: Map<string, Socket>;
  hostedPtyRegistry: HostedPtyRegistry;
  agentStatusRegistry: AgentStatusRegistry;
  // 同步终止路径必须广播 session list，否则 web 看到幽灵 row。hosted PTY 终止异步走
  // child.onExit → onSessionClosed → cleanupSessionResources 内部已广播，因此 hosted
  // 路径不在此处调用。所有同步路径（detach_local_terminal /
  // terminate_terminal_worker / terminate_json_worker）由本函数收口调用，
  // 调用方不必手动补。
  broadcastSessionList: () => void;
}

export function terminateSessionByOwnership(
  deps: TerminateSessionDeps,
  sessionId: string,
): { success: boolean; action: SessionTerminationAction } {
  const session = deps.sessionManager.getSession(sessionId);

  if (
    session?.mode === "pty" &&
    session.ptyOwner === "local-terminal" &&
    session.kind === "terminal"
  ) {
    const terminalSocket = deps.terminalSockets.get(sessionId);
    if (terminalSocket?.writable) {
      terminalSocket.write(serializeIpc({ type: "pty_terminate", sessionId }));
    } else if (session.pid) {
      try {
        process.kill(session.pid, "SIGTERM");
      } catch (err) {
        serviceLogger.warn(
          { sessionId, pid: session.pid, error: String(err) },
          "Terminal worker kill failed",
        );
      }
    }
    deps.terminalSockets.delete(sessionId);
    const result = deps.sessionManager.terminateSession(sessionId);
    deps.controlHandlers.cleanup(sessionId);
    deps.agentStatusRegistry.delete(sessionId);
    deps.broadcastSessionList();
    serviceLogger.info(
      { sessionId, success: result.success },
      "Terminal worker session terminated",
    );
    return { success: result.success, action: "terminate_terminal_worker" };
  }

  if (session?.mode === "pty" && session.ptyOwner === "local-terminal") {
    const terminalSocket = deps.terminalSockets.get(sessionId);
    if (terminalSocket?.writable) {
      terminalSocket.write(serializeIpc({ type: "pty_detach", sessionId }));
    }
    deps.terminalSockets.delete(sessionId);
    const result = deps.sessionManager.terminateSession(sessionId, {
      preserveProviderHooks: true,
    });
    deps.controlHandlers.cleanup(sessionId);
    deps.agentStatusRegistry.delete(sessionId);
    deps.broadcastSessionList();
    serviceLogger.info(
      { sessionId, success: result.success },
      "Local terminal session detached from remote view",
    );
    return { success: result.success, action: "detach_local_terminal" };
  }

  if (session?.mode === "pty" && session.ptyOwner === "proxy-hosted") {
    const success = deps.hostedPtyRegistry.terminate(sessionId);
    serviceLogger.info({ sessionId, success }, "Hosted PTY termination requested");
    return { success, action: "terminate_hosted_pty" };
  }

  if (session?.mode === "json") {
    deps.workerRegistry.send(sessionId, { type: "worker_stop" });
    deps.workerRegistry.delete(sessionId);
    const result = deps.sessionManager.terminateSession(sessionId);
    deps.controlHandlers.cleanup(sessionId);
    deps.agentStatusRegistry.delete(sessionId);
    deps.broadcastSessionList();
    serviceLogger.info({ sessionId, success: result.success }, "JSON worker session terminated");
    return { success: result.success, action: "terminate_json_worker" };
  }

  const hostedTerminated = deps.hostedPtyRegistry.terminate(sessionId);
  if (hostedTerminated) {
    return { success: true, action: "terminate_hosted_pty" };
  }
  return { success: false, action: "not_found" };
}
