import {
  PROFILE_NAME,
  SOCK_PATH,
  SERVICE_CONTROL_PATH,
  SERVICE_RUNTIME_LOCK_PATH,
  SERVICE_OPERATION_LOCK_PATH,
  STOPPED_PATH,
  ensureProfileWorkspace,
} from "./paths.js";
import { spawnScript } from "./env.js";
import { daemonRelayArgs } from "./daemon-env.js";
import { createServiceLifecycle } from "./service-lifecycle.js";

export function createProfileServiceLifecycle(
  options: {
    relayName?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  ensureProfileWorkspace();
  return createServiceLifecycle({
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
}
