import { homedir } from "node:os";
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

  onProxyInfoRequest(): void {
    this.deps.relaySend(
      JSON.stringify({
        type: "proxy_info",
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
      return;
    }
    this.deps.controlHandlers.pushCommandList(sid, session.cwd);
    this.deps.controlHandlers.pushFileTree(sid, session.cwd);
    serviceLogger.info({ sessionId: sid, cwd: session.cwd }, "Session resources pushed");
  }
}
