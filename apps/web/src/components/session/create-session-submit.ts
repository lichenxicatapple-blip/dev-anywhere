import {
  ControlErrorCode,
  type AgentCliStatus,
  type ControlErrorCodeType,
  type RelayControlMessage,
  type SessionInfo,
} from "@dev-anywhere/shared";

export type SessionMode = "pty" | "json";
export type ProviderId = "claude" | "codex";
export type PermissionMode = "default" | "auto" | "acceptEdits" | "plan" | "bypassPermissions";

const SESSION_CREATE_TIMEOUT_MS = 15_000;
const MISSING_CWD_PREFIX = "工作目录不存在或不可访问:";

export const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "严格审批" },
  { value: "auto", label: "自动判定" },
  { value: "acceptEdits", label: "自动接受编辑" },
  { value: "plan", label: "只读规划" },
  { value: "bypassPermissions", label: "跳过全部审批" },
];

export const CODEX_PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode; label: string }> = [
  { value: "default", label: "严格审批" },
  { value: "auto", label: "自动判定" },
  { value: "bypassPermissions", label: "跳过全部审批" },
];

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

type SessionCreateResponse = Extract<RelayControlMessage, { type: "session_create_response" }>;

interface CreateSessionRelay {
  createSession(
    request: {
      cwd: string;
      name?: string;
      mode: SessionMode;
      provider: ProviderId;
      permissionMode: PermissionMode;
    },
    timeoutMs?: number,
  ): Promise<SessionCreateResponse>;
}

interface CreateSessionFormSnapshot {
  cwd: string;
  name: string;
  mode: SessionMode;
  provider: ProviderId;
  permissionMode: PermissionMode;
}

type CreateSessionSubmitResult =
  | { type: "validation_error"; message: string }
  | { type: "relay_missing"; message: string }
  | { type: "provider_unavailable"; message: string }
  | { type: "missing_cwd"; message: string; path: string }
  | { type: "create_error"; message: string }
  | { type: "exception"; message: string }
  | { type: "success"; session: SessionInfo; route: string };

export function extractMissingCwd(error: string, errorCode?: ControlErrorCodeType): string | null {
  if (errorCode !== ControlErrorCode.PATH_NOT_FOUND || !error.startsWith(MISSING_CWD_PREFIX)) {
    return null;
  }
  const path = error.slice(MISSING_CWD_PREFIX.length).trim();
  return path || null;
}

export function providerStatus(
  provider: ProviderId,
  agentCli: AgentCliStatus | null,
): { label: string; disabled: boolean; title?: string } {
  if (!agentCli) {
    return { label: "检测中", disabled: true };
  }
  const status = agentCli[provider];
  if (status.available) {
    return { label: "可用", disabled: false, title: status.command };
  }
  return { label: "未找到", disabled: true, title: status.error };
}

export function providerTooltip(
  provider: ProviderId,
  status: ReturnType<typeof providerStatus>,
): string {
  if (status.title) {
    return status.disabled
      ? `${PROVIDER_LABEL[provider]}：${status.title}`
      : `${PROVIDER_LABEL[provider]} 路径：${status.title}`;
  }
  return `${PROVIDER_LABEL[provider]}：${status.label}`;
}

export function normalizePermissionModeForProvider(
  provider: ProviderId,
  permissionMode: PermissionMode,
): PermissionMode {
  if (provider !== "codex") return permissionMode;
  return CODEX_PERMISSION_MODE_OPTIONS.some((option) => option.value === permissionMode)
    ? permissionMode
    : "default";
}

export async function submitSessionCreate({
  relay,
  agentCli,
  form,
  timeoutMs = SESSION_CREATE_TIMEOUT_MS,
}: {
  relay: CreateSessionRelay | null | undefined;
  agentCli: AgentCliStatus | null;
  form: CreateSessionFormSnapshot;
  timeoutMs?: number;
}): Promise<CreateSessionSubmitResult> {
  const targetCwd = form.cwd.trim();
  if (!targetCwd) {
    return { type: "validation_error", message: "请输入工作目录" };
  }
  if (!relay) {
    return { type: "relay_missing", message: "请先连接开发机" };
  }

  const status = providerStatus(form.provider, agentCli);
  if (status.disabled) {
    const reason = agentCli?.[form.provider]?.error;
    return {
      type: "provider_unavailable",
      message: reason
        ? `${PROVIDER_LABEL[form.provider]} 不可用：${reason}`
        : `${PROVIDER_LABEL[form.provider]} 暂不可用`,
    };
  }

  const submittedMode = form.mode;
  const submittedProvider = form.provider;
  const submittedName = form.name.trim();

  try {
    const response = await relay.createSession(
      {
        cwd: targetCwd,
        name: submittedName || undefined,
        mode: submittedMode,
        provider: submittedProvider,
        permissionMode: form.permissionMode,
      },
      timeoutMs,
    );

    if (response.error || !response.sessionId) {
      const missingPath = extractMissingCwd(response.error ?? "", response.errorCode);
      if (missingPath) {
        return { type: "missing_cwd", path: missingPath, message: "找不到这个工作目录" };
      }
      return { type: "create_error", message: `创建失败：${response.error ?? "未知错误"}` };
    }

    const mode = response.mode ?? submittedMode;
    const resolvedName = response.name?.trim() || undefined;
    const session: SessionInfo = {
      sessionId: response.sessionId,
      name: resolvedName,
      ...(response.nameLocked !== undefined ? { nameLocked: response.nameLocked } : {}),
      state: "idle",
      mode,
      provider: response.provider ?? submittedProvider,
      ...(response.ptyOwner !== undefined ? { ptyOwner: response.ptyOwner } : {}),
    };
    return { type: "success", session, route: `/chat/${response.sessionId}?mode=${mode}` };
  } catch (err) {
    return { type: "exception", message: err instanceof Error ? err.message : String(err) };
  }
}
