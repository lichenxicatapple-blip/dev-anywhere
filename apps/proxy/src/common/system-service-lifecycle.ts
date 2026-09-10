import { requestServiceHost, type ServiceHostRequest } from "./service-host-control.js";
import {
  ServiceLifecycleError,
  type ServiceLifecycle,
  type ServiceReadyResult,
} from "./service-lifecycle.js";

/** Delegate to the system host so a CLI invoked from a desktop never owns the new Proxy. */
export function withSystemServiceHost(
  local: ServiceLifecycle,
  options: {
    endpoint: string;
    profile: string;
    relay?: string;
    registered(): boolean;
  },
): ServiceLifecycle {
  const execute = async (
    request: ServiceHostRequest,
  ): Promise<ServiceReadyResult | "stopped" | null> => {
    const result = await requestServiceHost(options.endpoint, options.profile, {
      ...request,
      ...(options.relay && request.action !== "stop" ? { relay: options.relay } : {}),
    });
    if (result === null) {
      if (options.registered() && request.action !== "stop") {
        throw new Error(
          `System startup is enabled, but the system service is not running. Reboot or run "dev-anywhere --profile ${options.profile} serve autostart enable --system --now".`,
        );
      }
      return null;
    }
    if (result.status === "failed") {
      const code = (
        ["STOP_FAILED", "START_FAILED", "STOPPED", "UNSUPPORTED_SERVICE"] as const
      ).find((value) => value === result.code);
      const error = new ServiceLifecycleError(
        code ?? (request.action === "stop" ? "STOP_FAILED" : "START_FAILED"),
        result.message,
      );
      error.recoveryToken = result.recoveryToken;
      throw error;
    }
    if (result.status === "stopped" && request.action === "stop") return "stopped";
    if (result.status !== "ready" || request.action === "stop")
      throw new Error("Unexpected system service result");
    return {
      status: "ready",
      service: {
        pid: result.pid,
        instanceId: result.instanceId,
        version: result.version,
        profile: options.profile,
        state: "ready",
      },
    };
  };
  const start = async (intent: "explicit" | "recover", recoveryToken?: string) => {
    const result = await execute({ action: "start", intent, recoveryToken });
    if (result === "stopped") throw new Error("Unexpected stopped service");
    return result ?? local.start(intent, recoveryToken);
  };
  return {
    status: local.status,
    start,
    startForeground: async (foreground) => {
      const result = await execute({ action: "start", intent: "explicit" });
      if (result === "stopped") throw new Error("Unexpected stopped service");
      return result ?? local.startForeground(foreground);
    },
    stop: async () => {
      if ((await execute({ action: "stop" })) === null) await local.stop();
    },
    restart: async (intent = "explicit") => {
      const result = await execute({ action: "restart", intent });
      if (result === "stopped") throw new Error("Unexpected stopped service");
      return result ?? local.restart(intent);
    },
  };
}
