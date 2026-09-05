import type { Socket } from "node:net";
import { serviceLogger } from "../common/logger.js";
import { isManagedSessionProcess } from "../common/managed-session-process.js";
import { serializeIpc } from "../ipc/ipc-protocol.js";
import type { SessionManager } from "./session-manager.js";
import type { WorkerRegistry } from "./worker-registry.js";

type SessionTerminationAction =
  | "detach_local_terminal"
  | "terminate_terminal_worker"
  | "terminate_json_worker"
  | "not_found";

interface TerminateSessionDeps {
  sessionManager: SessionManager;
  workerRegistry: WorkerRegistry;
  terminalSockets: Map<string, Socket>;
  isManagedSessionProcess?: typeof isManagedSessionProcess;
}

export function terminateSessionByOwnership(
  deps: TerminateSessionDeps,
  sessionId: string,
): { success: boolean; action: SessionTerminationAction } {
  const session = deps.sessionManager.getSession(sessionId);

  if (session?.mode === "pty" && session.ptyOwner === "proxy-hosted") {
    const terminalSocket = deps.terminalSockets.get(sessionId);
    if (terminalSocket?.writable) {
      terminalSocket.write(serializeIpc({ type: "pty_terminate", sessionId }));
    } else if (session.pid) {
      const ownsPid = (deps.isManagedSessionProcess ?? isManagedSessionProcess)(session.pid, {
        id: session.id,
        mode: "pty",
        kind: session.kind,
        provider: session.provider,
        ptyOwner: "proxy-hosted",
      });
      if (ownsPid) {
        try {
          process.kill(session.pid, "SIGTERM");
        } catch (err) {
          serviceLogger.warn(
            { sessionId, pid: session.pid, error: String(err) },
            "Terminal worker kill failed",
          );
        }
      } else {
        serviceLogger.warn(
          { sessionId, pid: session.pid },
          "Terminal worker PID identity could not be verified; signal skipped",
        );
      }
    }
    deps.terminalSockets.delete(sessionId);
    const result = deps.sessionManager.terminateSession(sessionId);
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
    serviceLogger.info(
      { sessionId, success: result.success },
      "Local terminal session detached from remote view",
    );
    return { success: result.success, action: "detach_local_terminal" };
  }

  if (session?.mode === "json") {
    const stopDelivered = deps.workerRegistry.send(sessionId, { type: "worker_stop" });
    if (stopDelivered) {
      deps.workerRegistry.delete(sessionId);
    } else {
      deps.workerRegistry.terminateProcess(sessionId);
    }
    const result = deps.sessionManager.terminateSession(sessionId);
    serviceLogger.info(
      { sessionId, success: result.success, stopDelivered },
      "JSON worker session terminated",
    );
    return { success: result.success, action: "terminate_json_worker" };
  }

  return { success: false, action: "not_found" };
}
