import {
  PROFILE_NAME,
  SOCK_PATH,
  SERVICE_CONTROL_PATH,
  SERVICE_RUNTIME_LOCK_PATH,
  SERVICE_OPERATION_LOCK_PATH,
  STOPPED_PATH,
  ensureProfileWorkspace,
  SERVICE_HOST_PATH,
  SYSTEM_AUTOSTART_PATH,
} from "./paths.js";
import { existsSync } from "node:fs";
import { spawnScript } from "./env.js";
import { daemonRelayArgs } from "./daemon-env.js";
import { createServiceLifecycle } from "./service-lifecycle.js";
import { withSystemServiceHost } from "./system-service-lifecycle.js";

export function createProfileServiceLifecycle(
  options: {
    relayName?: string;
    env?: NodeJS.ProcessEnv;
    /** Only the system host's command subprocess bypasses IPC delegation. */
    hostCommand?: boolean;
  } = {},
) {
  ensureProfileWorkspace();
  const local = createServiceLifecycle({
    profile: PROFILE_NAME,
    socketPath: SOCK_PATH,
    controlPath: SERVICE_CONTROL_PATH,
    runtimeLockPath: SERVICE_RUNTIME_LOCK_PATH,
    operationLockPath: SERVICE_OPERATION_LOCK_PATH,
    stoppedPath: STOPPED_PATH,
    spawn: () =>
      spawnScript("serve", ["--profile", PROFILE_NAME, ...daemonRelayArgs(options.relayName)], {
        env: { ...(options.env ?? process.env) },
        stdio: "ignore",
        unref: false,
      }),
  });
  return options.hostCommand
    ? local
    : withSystemServiceHost(local, {
        endpoint: SERVICE_HOST_PATH,
        profile: PROFILE_NAME,
        relay: options.relayName,
        registered: () => existsSync(SYSTEM_AUTOSTART_PATH),
      });
}
