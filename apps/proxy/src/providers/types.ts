export type ProviderId = "claude" | "codex";

export interface ProviderCapabilities {
  readonly supportsHooks: boolean;
  readonly supportsSessionScopedConfig: boolean;
  readonly supportsProjectScopedConfig: boolean;
  readonly supportsGlobalSetup: boolean;
}

export interface ProviderCommand {
  readonly command: string;
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface ProviderHookContext {
  readonly provider: ProviderId;
  readonly sessionId: string;
  readonly hookUrl: string;
  readonly marker: string;
  readonly token: string;
}

export interface ProviderJsonOptions {
  readonly extraArgs?: string[];
  readonly permissionMode?: string;
  readonly resumeSessionId?: string;
  readonly includePartialMessages?: boolean;
  readonly hook?: ProviderHookContext;
}

export interface ProviderTerminalOptions {
  readonly args: string[];
  readonly permissionMode?: string;
  readonly hook?: ProviderHookContext;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  buildJsonCommand(options: ProviderJsonOptions, env: NodeJS.ProcessEnv): ProviderCommand;
  buildTerminalCommand(options: ProviderTerminalOptions, env: NodeJS.ProcessEnv): ProviderCommand;
}
