import type { Socket } from "node:net";
import { serviceLogger } from "../common/logger.js";
import { serializeRawPtyInput } from "./pty-input.js";
import type { HostedPtyRegistry } from "./hosted-pty-registry.js";
import type { JsonObserver } from "./json-observer.js";
import type { SessionManager } from "./session-manager.js";
import type { WorkerRegistry } from "./worker-registry.js";

interface RelayInputHandlersDeps {
  sessionManager: SessionManager;
  workerRegistry: WorkerRegistry;
  terminalSockets: Map<string, Socket>;
  hostedPtyRegistry: HostedPtyRegistry;
  jsonObserver: JsonObserver;
}

export class RelayInputHandlers {
  constructor(private readonly deps: RelayInputHandlersDeps) {}

  onUserInput(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    if (!sessionId) return;

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) {
      serviceLogger.warn({ sessionId }, "Remote input dropped: session not found");
      return;
    }

    const payload = msg.payload as { text?: string } | undefined;
    const text = payload?.text ?? "";

    if (session.mode === "json") {
      this.deps.jsonObserver.onTurnStart(sessionId);
      const sent = this.deps.workerRegistry.send(sessionId, {
        type: "worker_input",
        content: text,
      });
      if (!sent) {
        serviceLogger.warn({ sessionId }, "Remote input dropped: JSON worker socket not available");
        return;
      }
      serviceLogger.info({ sessionId }, "Remote input forwarded to JSON worker");
      return;
    }

    serviceLogger.warn(
      { sessionId, mode: session.mode },
      "Remote batch input dropped: PTY sessions require remote_input_raw",
    );
  }

  onRemoteInputRaw(msg: Record<string, unknown>): void {
    const sessionId = msg.sessionId as string | undefined;
    const data = msg.data as string | undefined;
    if (!sessionId || data === undefined) return;

    const ts = this.deps.terminalSockets.get(sessionId);
    if (!ts?.writable && this.deps.hostedPtyRegistry.write(sessionId, data)) {
      serviceLogger.info(
        { sessionId, bytes: data.length },
        "Raw PTY input forwarded to hosted PTY",
      );
      return;
    }
    if (!ts?.writable) {
      serviceLogger.warn({ sessionId }, "Raw PTY input dropped: terminal socket unavailable");
      return;
    }
    ts.write(serializeRawPtyInput(sessionId, data));
    serviceLogger.info({ sessionId, bytes: data.length }, "Raw PTY input forwarded");
  }
}
