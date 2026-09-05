import type {
  ProviderAdapter,
  ProviderCommand,
  ProviderJsonOptions,
  ProviderTerminalOptions,
} from "./types.js";
import { resolveExecutable } from "./path-resolver.js";

export const CODEX_STRICT_APPROVAL_UNSUPPORTED_MESSAGE =
  "新版 Codex 不支持“严格审批”。请刷新页面后选择“按需审批”或“跳过全部审批”。";

export class CodexApprovalPolicyUnsupportedError extends Error {
  constructor(permissionMode: string) {
    super(
      permissionMode === "default"
        ? CODEX_STRICT_APPROVAL_UNSUPPORTED_MESSAGE
        : `Codex 不支持审批策略“${permissionMode}”。请刷新页面后重新选择。`,
    );
    this.name = "CodexApprovalPolicyUnsupportedError";
  }
}

export interface CodexPermissionPolicy {
  approvalPolicy?: "on-request" | "never";
  sandbox?: "danger-full-access";
}

export function resolveCodexPermissionPolicy(permissionMode?: string): CodexPermissionPolicy {
  switch (permissionMode) {
    case undefined:
      // 未显式选择时尊重 Codex 自己的本机配置。
      return {};
    case "auto":
      return { approvalPolicy: "on-request" };
    case "bypassPermissions":
      return { approvalPolicy: "never", sandbox: "danger-full-access" };
    default:
      // `default` 曾被映射到已被新版 Codex 删除的 `untrusted`。不做静默降级，
      // 否则用户看到的“严格审批”与真实运行策略不一致。
      throw new CodexApprovalPolicyUnsupportedError(permissionMode);
  }
}

function withCodexTerminalPermissionArgs(args: string[], permissionMode?: string): string[] {
  const policy = resolveCodexPermissionPolicy(permissionMode);
  if (policy.sandbox === "danger-full-access") {
    return ["--dangerously-bypass-approvals-and-sandbox", ...args];
  }
  if (policy.approvalPolicy === "on-request") {
    return ["--ask-for-approval", "on-request", ...args];
  }
  return [...args];
}

export function resolveCodexCommand(env: NodeJS.ProcessEnv, cwd?: string): string {
  return resolveExecutable(
    "codex",
    env,
    "CODEX_BIN",
    "codex not found in PATH. Set CODEX_BIN or install Codex CLI.",
    cwd,
  );
}

export const CODEX_PROVIDER: ProviderAdapter = {
  id: "codex",
  displayName: "Codex CLI",
  capabilities: {
    supportsHooks: true,
    supportsSessionScopedConfig: true,
    supportsProjectScopedConfig: true,
    supportsGlobalSetup: true,
  },
  buildJsonCommand(options: ProviderJsonOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    return {
      command: resolveCodexCommand(env, options.cwd),
      args: ["app-server", "--listen", "stdio://"],
      env,
    };
  },
  buildTerminalCommand(options: ProviderTerminalOptions, env: NodeJS.ProcessEnv): ProviderCommand {
    const args = withCodexTerminalPermissionArgs(options.args, options.permissionMode);
    return {
      command: resolveCodexCommand(env, options.cwd),
      args,
      env,
    };
  },
};
