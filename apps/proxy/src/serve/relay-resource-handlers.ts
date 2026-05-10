import { homedir } from "node:os";
import { accessSync, constants, statSync } from "node:fs";
import { ControlErrorCode, serializeControl, type ControlMessage } from "@dev-anywhere/shared";
import type { ControlMessageHandlers } from "./handlers/control-messages.js";
import type { RelaySend } from "./relay-router-types.js";
import type { SessionManager } from "./session-manager.js";
import { serviceLogger } from "../common/logger.js";
import { saveAgentCliPath } from "../common/config.js";
import { detectAgentCliStatus } from "../providers/index.js";
import type { ProviderId } from "../providers/types.js";

interface RelayResourceHandlersDeps {
  relaySend: RelaySend;
  controlHandlers: ControlMessageHandlers;
  sessionManager: SessionManager;
  getProviderEnv: () => NodeJS.ProcessEnv;
  getAgentCliSuggestions: () => Partial<Record<ProviderId, string[]>>;
  setAgentCliPath: (provider: ProviderId, path: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function validateExecutablePath(path: string): string {
  const normalized = path.trim();
  if (!normalized.startsWith("/")) throw new Error("CLI 路径必须是绝对路径");
  const stat = statSync(normalized);
  if (!stat.isFile()) throw new Error("CLI 路径不是可执行文件");
  accessSync(normalized, constants.X_OK);
  return normalized;
}

export class RelayResourceHandlers {
  constructor(private readonly deps: RelayResourceHandlersDeps) {}

  onProxyInfoRequest(msg: ControlMessage<"proxy_info_request">): void {
    this.deps.relaySend(
      serializeControl({
        type: "proxy_info",
        requestId: msg.requestId,
        homePath: homedir() || "/",
        agentCli: detectAgentCliStatus(this.deps.getProviderEnv(), {
          suggestions: this.deps.getAgentCliSuggestions(),
        }),
      }),
    );
  }

  onAgentCliConfigUpdate(msg: ControlMessage<"agent_cli_config_update">): void {
    const { requestId, provider } = msg;
    const rawPath = msg.path;

    if (provider !== "claude" && provider !== "codex") {
      this.deps.relaySend(
        serializeControl({
          type: "agent_cli_config_update_response",
          requestId,
          provider: "claude",
          errorCode: ControlErrorCode.PROVIDER_UNSUPPORTED,
          error: "Unsupported Agent CLI.",
        }),
      );
      return;
    }

    try {
      const path = validateExecutablePath(rawPath ?? "");
      saveAgentCliPath(provider, path);
      this.deps.setAgentCliPath(provider, path);
      const agentCli = detectAgentCliStatus(this.deps.getProviderEnv(), {
        suggestions: this.deps.getAgentCliSuggestions(),
      });
      this.deps.relaySend(
        serializeControl({
          type: "agent_cli_config_update_response",
          requestId,
          provider,
          agentCli,
        }),
      );
      serviceLogger.info({ provider, path }, "Agent CLI path updated");
    } catch (err) {
      const error = errorMessage(err);
      this.deps.relaySend(
        serializeControl({
          type: "agent_cli_config_update_response",
          requestId,
          provider,
          errorCode: ControlErrorCode.INVALID_PATH,
          error,
        }),
      );
      serviceLogger.warn({ provider, path: rawPath, error }, "Agent CLI path update rejected");
    }
  }

  onDirListRequest(msg: ControlMessage<"dir_list_request">): void {
    this.deps.controlHandlers.handleDirListRequest({
      path: msg.path ?? "",
      requestId: msg.requestId,
    });
  }

  onDirCreateRequest(msg: ControlMessage<"dir_create_request">): void {
    this.deps.controlHandlers.handleDirCreateRequest({
      path: msg.path ?? "",
      requestId: msg.requestId,
    });
  }

  onSessionResourcesRequest(msg: ControlMessage<"session_resources_request">): void {
    const sid = msg.sessionId;
    if (!sid) return;

    const session = this.deps.sessionManager.getSession(sid);
    if (!session?.cwd) {
      serviceLogger.warn({ sessionId: sid }, "Session resources request: no cwd available");
      this.deps.relaySend(
        serializeControl({
          type: "session_resources_response",
          requestId: msg.requestId,
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
      requestId: msg.requestId,
      workDir: session.cwd,
    });
    serviceLogger.info({ sessionId: sid, cwd: session.cwd }, "Session resources requested");
  }
}
