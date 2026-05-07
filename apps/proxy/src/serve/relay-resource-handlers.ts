import { homedir } from "node:os";
import { ControlErrorCode } from "@dev-anywhere/shared";
import type { ControlMessageHandlers } from "./handlers/control-messages.js";
import type { RelaySend } from "./relay-router-types.js";
import type { SessionManager } from "./session-manager.js";
import { serviceLogger } from "../common/logger.js";

interface RelayResourceHandlersDeps {
  relaySend: RelaySend;
  controlHandlers: ControlMessageHandlers;
  sessionManager: SessionManager;
}

export class RelayResourceHandlers {
  constructor(private readonly deps: RelayResourceHandlersDeps) {}

  onProxyInfoRequest(msg: Record<string, unknown>): void {
    this.deps.relaySend(
      JSON.stringify({
        type: "proxy_info",
        requestId: msg.requestId as string | undefined,
        homePath: homedir() || "/",
      }),
    );
  }

  onDirListRequest(msg: Record<string, unknown>): void {
    this.deps.controlHandlers.handleDirListRequest({
      path: (msg.path as string) ?? "",
      requestId: msg.requestId as string | undefined,
    });
  }

  onDirCreateRequest(msg: Record<string, unknown>): void {
    this.deps.controlHandlers.handleDirCreateRequest({
      path: (msg.path as string) ?? "",
      requestId: msg.requestId as string | undefined,
    });
  }

  onSessionResourcesRequest(msg: Record<string, unknown>): void {
    const sid = msg.sessionId as string | undefined;
    if (!sid) return;

    const session = this.deps.sessionManager.getSession(sid);
    if (!session?.cwd) {
      serviceLogger.warn({ sessionId: sid }, "Session resources request: no cwd available");
      this.deps.relaySend(
        JSON.stringify({
          type: "session_resources_response",
          requestId: msg.requestId as string | undefined,
          sessionId: sid,
          commands: [],
          groups: [],
          errorCode: ControlErrorCode.SESSION_NOT_FOUND,
          error: "Session not found or cwd unavailable",
        }),
      );
      return;
    }
    this.deps.controlHandlers.handleSessionResourcesRequest({
      sessionId: sid,
      requestId: msg.requestId as string | undefined,
      workDir: session.cwd,
    });
    serviceLogger.info({ sessionId: sid, cwd: session.cwd }, "Session resources requested");
  }
}
