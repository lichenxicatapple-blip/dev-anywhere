import { isAbsolute } from "node:path";

export interface E2EBackendConfig {
  profile: string;
  relay?: string;
  relayPort: string;
}

export interface E2ERelayRestartConfig extends E2EBackendConfig {
  logDir: string;
}

export function requireE2EBackendConfig(env: NodeJS.ProcessEnv = process.env): E2EBackendConfig {
  const profile = env.DEV_ANYWHERE_E2E_PROFILE?.trim();
  if (!profile) {
    throw new Error(
      "DEV_ANYWHERE_E2E_PROFILE is required for real backend E2E; use an isolated test profile",
    );
  }
  if (profile === "." || profile === ".." || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(profile)) {
    throw new Error("DEV_ANYWHERE_E2E_PROFILE must be a valid Proxy profile name");
  }

  const relayPort = env.DEV_ANYWHERE_E2E_RELAY_PORT?.trim();
  const parsedRelayPort = Number(relayPort);
  if (
    !relayPort ||
    !/^\d+$/.test(relayPort) ||
    !Number.isSafeInteger(parsedRelayPort) ||
    parsedRelayPort < 1 ||
    parsedRelayPort > 65_535
  ) {
    throw new Error(
      "DEV_ANYWHERE_E2E_RELAY_PORT is required for real backend E2E and must be a valid port",
    );
  }

  const relay = env.DEV_ANYWHERE_E2E_RELAY?.trim() || undefined;
  return { profile, ...(relay ? { relay } : {}), relayPort };
}

export function requireE2ERelayRestartConfig(
  env: NodeJS.ProcessEnv = process.env,
): E2ERelayRestartConfig {
  const config = requireE2EBackendConfig(env);
  const logDir = env.DEV_ANYWHERE_E2E_LOG_DIR?.trim();
  if (!logDir || !isAbsolute(logDir)) {
    throw new Error(
      "DEV_ANYWHERE_E2E_LOG_DIR must be an absolute path when real backend E2E restarts the Relay",
    );
  }
  return { ...config, logDir };
}
