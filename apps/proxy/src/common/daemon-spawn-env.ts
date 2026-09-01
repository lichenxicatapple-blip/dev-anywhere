import {
  refreshLoginShellPath,
  type LoginShellPathFailureReason,
  type LoginShellPathRefreshOptions,
} from "./login-shell-path.js";
import { isDirectAutoUpdateInvocation } from "./auto-update-invocation.js";

export type DaemonSpawnPathSource = "caller" | "login-shell" | "fallback";

export interface DaemonSpawnEnvironment {
  env: NodeJS.ProcessEnv;
  pathSource: DaemonSpawnPathSource;
  failureReason?: LoginShellPathFailureReason;
}

interface PrepareDaemonSpawnEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  autoUpdateInvocation?: boolean;
  refreshOptions?: Omit<LoginShellPathRefreshOptions, "env">;
}

/**
 * Prepares the environment inherited by a newly spawned daemon.
 *
 * Manual start/restart keeps the caller's environment verbatim. A service command launched directly
 * by the auto-update runner refreshes only PATH from the user's interactive login shell; every other
 * environment variable remains inherited from the updater. Refresh failures keep the old PATH so an
 * optional convenience step can never prevent the service from restarting.
 */
export async function prepareDaemonSpawnEnvironment(
  options: PrepareDaemonSpawnEnvironmentOptions = {},
): Promise<DaemonSpawnEnvironment> {
  const inheritedEnv = options.env ?? process.env;
  const env = { ...inheritedEnv };
  const autoUpdateInvocation = options.autoUpdateInvocation ?? isDirectAutoUpdateInvocation();

  if (!autoUpdateInvocation) return { env, pathSource: "caller" };

  const refreshed = await refreshLoginShellPath({
    ...options.refreshOptions,
    env: inheritedEnv,
  });
  if (refreshed.path === undefined) delete env.PATH;
  else env.PATH = refreshed.path;

  return refreshed.source === "login-shell"
    ? { env, pathSource: "login-shell" }
    : { env, pathSource: "fallback", failureReason: refreshed.reason };
}
