import { homedir } from "node:os";
import { accessSync, constants, statSync } from "node:fs";
import { ControlErrorCode } from "@dev-anywhere/shared";
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

  onProxyInfoRequest(msg: Record<string, unknown>): void {
    this.deps.relaySend(
      JSON.stringify({
        type: "proxy_info",
        requestId: msg.requestId as string | undefined,
        homePath: homedir() || "/",
        agentCli: detectAgentCliStatus(this.deps.getProviderEnv(), {
          suggestions: this.deps.getAgentCliSuggestions(),
        }),
      }),
    );
  }

  onAgentCliConfigUpdate(msg: Record<string, unknown>): void {
    const requestId = msg.requestId as string | undefined;
    const provider = msg.provider as ProviderId | undefined;
    const rawPath = msg.path as string | undefined;

    if (provider !== "claude" && provider !== "codex") {
      this.deps.relaySend(
        JSON.stringify({
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
        JSON.stringify({
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
        JSON.stringify({
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
