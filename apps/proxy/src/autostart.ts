import { homedir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { IS_DEV, resolveTopLevelScript } from "./common/env.js";
import { isInitialized, PROFILE_NAME } from "./common/paths.js";
import { createServiceAutostart } from "./common/service-autostart.js";
import { createProfileServiceLifecycle } from "./common/profile-service.js";
import { refreshLoginShellPath } from "./common/login-shell-path.js";
import { getErrorMessage } from "./common/process-probe.js";

export async function runAutostartCommand(action: "enable" | "disable" | "status"): Promise<void> {
  try {
    if (action === "enable" && !isInitialized()) {
      throw new Error('Dev Anywhere is not initialized. Run "dev-anywhere init" first.');
    }
    const entry = `${fileURLToPath(resolveTopLevelScript("index"))}${IS_DEV ? ".ts" : ".js"}`;
    const autostart = createServiceAutostart({
      platform: process.platform,
      home: homedir(),
      profile: PROFILE_NAME,
      executable: process.execPath,
      args: IS_DEV ? ["--import", import.meta.resolve("tsx"), entry] : [entry],
      env: { ...process.env, SHELL: process.env.SHELL ?? userInfo().shell ?? undefined },
      uid: process.getuid?.(),
    });
    if (action === "status") {
      console.log(
        `${PROFILE_NAME}: ${(await autostart.status()) ? "已设置登录后自动启动" : "未设置自动启动"}`,
      );
      return;
    }
    await autostart[action]();
    console.log(
      action === "enable"
        ? `${PROFILE_NAME}: 已设置登录后自动启动，当前 Proxy 不受影响。`
        : `${PROFILE_NAME}: 已取消自动启动，当前 Proxy 不受影响。`,
    );
  } catch (error) {
    console.error(getErrorMessage(error));
    process.exitCode = 1;
  }
}

/** System login triggers enter the same lifecycle controller as manual CLI commands. */
export async function startAutostartService(daemon: boolean): Promise<void> {
  try {
    if (!isInitialized()) throw new Error("Proxy configuration is missing");
    if (process.platform !== "win32") {
      const refreshed = await refreshLoginShellPath({
        env: { ...process.env, SHELL: process.env.SHELL ?? userInfo().shell ?? undefined },
      });
      if (refreshed.path !== undefined) process.env.PATH = refreshed.path;
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
    serviceLogger.error({ err: getErrorMessage(error) }, "Proxy login startup failed");
    await flushLogger(serviceLogger);
    process.exit(1);
  }
}
