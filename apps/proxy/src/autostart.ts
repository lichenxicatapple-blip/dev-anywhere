import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { IS_DEV, resolveTopLevelScript } from "./common/env.js";
import { isInitialized, PROFILE_NAME, SERVICE_HOST_PATH } from "./common/paths.js";
import { createServiceAutostart } from "./common/service-autostart.js";
import { createSystemServiceAutostart } from "./common/system-service-autostart.js";
import { switchAutostartMode } from "./common/autostart-mode.js";
import { requestServiceHost } from "./common/service-host-control.js";
import { createProfileServiceLifecycle } from "./common/profile-service.js";
import { refreshLoginShellPath } from "./common/login-shell-path.js";
import { getErrorMessage } from "./common/process-probe.js";

export async function runAutostartCommand(
  action: "enable" | "disable" | "status",
  options: { system?: boolean; now?: boolean } = {},
): Promise<void> {
  try {
    if (options.now && (action !== "enable" || !options.system))
      throw new Error("--now requires autostart enable --system");
    if (action === "enable" && !isInitialized()) {
      throw new Error('Dev Anywhere is not initialized. Run "dev-anywhere init" first.');
    }
    const entry = `${fileURLToPath(resolveTopLevelScript("index"))}${IS_DEV ? ".ts" : ".js"}`;
    const account = userInfo();
    const settings = {
      platform: process.platform,
      home: homedir(),
      profile: PROFILE_NAME,
      executable: process.execPath,
      args: IS_DEV ? ["--import", import.meta.resolve("tsx"), entry] : [entry],
      env: { ...process.env, SHELL: process.env.SHELL ?? account.shell ?? undefined },
      uid: process.getuid?.(),
      username: account.username,
    };
    const login = createServiceAutostart(settings);
    const system = createSystemServiceAutostart(settings);
    const autostart = options.system ? system : login;
    if (action === "status") {
      console.log(
        `${PROFILE_NAME}: ${(await autostart.status()) ? (options.system ? "已设置开机自动启动（无需桌面登录）" : "已设置登录后自动启动") : "未设置此模式的自动启动"}`,
      );
      if (options.system) {
        const host = await requestServiceHost(SERVICE_HOST_PATH, PROFILE_NAME, { action: "probe" });
        console.log(
          `Service: ${system.label}; ${host?.status === "host" ? `running (PID ${host.pid})` : "not running"}`,
        );
      }
      return;
    }
    if (action === "enable") await switchAutostartMode(autostart, options.system ? login : system);
    else await autostart.disable();
    if (options.now) {
      const wasRunning = await requestServiceHost(SERVICE_HOST_PATH, PROFILE_NAME, {
        action: "probe",
      });
      await system.activate();
      const deadline = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < deadline) {
        const result = await requestServiceHost(SERVICE_HOST_PATH, PROFILE_NAME, {
          action: wasRunning ? "restart" : "start",
          intent: "explicit",
        });
        if (result?.status === "failed") throw new Error(result.message);
        if (result?.status === "ready") {
          ready = true;
          break;
        }
        await sleep(150);
      }
      if (!ready)
        throw new Error(
          "System service is registered, but did not become ready; check the OS service status",
        );
    }
    console.log(
      action === "enable"
        ? options.system
          ? `${PROFILE_NAME}: 已设置开机自动启动（无需桌面登录）。${options.now ? "Proxy 已启动；新建会话可在退出桌面后继续使用。" : "下次开机生效；立即启动请加 --now。"}`
          : `${PROFILE_NAME}: 已设置登录后自动启动，当前 Proxy 不受影响。`
        : `${PROFILE_NAME}: 已取消自动启动，当前 Proxy 不受影响。`,
    );
  } catch (error) {
    console.error(getErrorMessage(error));
    process.exitCode = 1;
  }
}

/** System login triggers enter the same lifecycle controller as manual CLI commands. */
export async function startAutostartService(daemon: boolean, system = false): Promise<void> {
  try {
    if (!isInitialized()) throw new Error("Proxy configuration is missing");
    if (process.platform !== "win32") {
      const refreshed = await refreshLoginShellPath({
        env: { ...process.env, SHELL: process.env.SHELL ?? userInfo().shell ?? undefined },
      });
      if (refreshed.path !== undefined) process.env.PATH = refreshed.path;
    }
    if (system) {
      if (daemon) throw new Error("The system service host must remain in the foreground");
      const { startSystemServiceHost } = await import("./service-host.js");
      await startSystemServiceHost();
      return;
    }
    const lifecycle = createProfileServiceLifecycle();
    if (daemon) await lifecycle.start("explicit");
    else
      await lifecycle.startForeground(async () => {
        const { startService } = await import("./serve.js");
        await startService();
      });
  } catch (error) {
    const { serviceLogger } = await import("./common/logger.js");
    const { flushLogger } = await import("@dev-anywhere/shared/logger");
    serviceLogger.error({ err: getErrorMessage(error) }, "Proxy automatic startup failed");
    await flushLogger(serviceLogger);
    process.exit(1);
  }
}
