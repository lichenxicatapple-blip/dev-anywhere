import { Command } from "commander";
import {
  SESSIONS_PATH,
  SESSION_RUNTIME_IPC_VERSION_PATH,
  SERVICE_LOG_PATH,
  CONFIG_PATH,
  PROFILE_NAME,
  isInitialized,
  initWorkspace,
} from "./common/paths.js";
import { prepareDaemonSpawnEnvironment } from "./common/daemon-spawn-env.js";
import { setDesiredDaemonRelay } from "./common/daemon-env.js";
import { getErrorMessage } from "./common/process-probe.js";
import { TERMINAL_IPC_PROTOCOL_VERSION, WORKER_IPC_PROTOCOL_VERSION } from "./ipc/ipc-protocol.js";
import { extractAgentInvocation, normalizeCliArgs, stripProxyProfileArgs } from "./cli-args.js";
import { readLiveLocalPtySessionIds, waitForSessionHandover } from "./common/restart-handover.js";
import { PROXY_VERSION } from "./version.js";
import { createProfileServiceLifecycle } from "./common/profile-service.js";
import { ServiceLifecycleError } from "./common/service-lifecycle.js";
import type { ServiceCommandResult } from "./common/service-command-result.js";

async function showStatus(): Promise<number> {
  const lines: string[] = [`Profile: ${PROFILE_NAME}`];
  try {
    const service = await createProfileServiceLifecycle().status();
    if (!service) {
      lines.push("Service: not running");
    } else {
      lines.push(`Service: ${service.state} (PID ${service.pid})`);
      lines.push(
        `Version: ${service.version === PROXY_VERSION ? service.version : `daemon ${service.version} (CLI ${PROXY_VERSION})`}`,
      );
      lines.push(`Log:     ${SERVICE_LOG_PATH}`);
      if (service.info) {
        const { config, relay, sessions } = service.info;
        lines.push(`Updates: ${config.autoUpdate ? "automatic (follows Relay)" : "disabled"}`);
        lines.push(`Relay:   ${config.relayName} (${config.relayNameSource})`);
        lines.push(`Config:  relay ${config.relayUrl ?? "(unset)"} (${config.relayUrlSource})`);
        lines.push(
          relay
            ? `Relay:   ${relay.connected ? "connected" : "disconnected"} (proxy: ${relay.proxyId}, queued: ${relay.queueDepth}, reconnect attempts: ${relay.reconnectAttempt})`
            : "Relay:   not configured",
        );
        lines.push("", sessions.length ? "Sessions:" : "Sessions: none");
        for (const session of sessions) {
          lines.push(
            `  ${session.id}  ${session.mode}  ${session.state}  worker: ${session.hasWorker ? "yes" : "no"}`,
          );
        }
      }
    }
  } catch (error) {
    lines.push(`Service: unavailable (${getErrorMessage(error)})`);
    process.exitCode = 1;
  }
  console.log(lines.join("\n"));
  return lines.length;
}

async function runServiceCommand(
  action: "start" | "stop" | "restart",
  options: { relay?: string; json?: boolean; recoverFrom?: string; ifRunning?: boolean },
): Promise<void> {
  let result: ServiceCommandResult;
  try {
    if (action !== "stop") setDesiredDaemonRelay(options.relay);
    const environment = action === "stop" ? undefined : await prepareDaemonSpawnEnvironment();
    const lifecycle = createProfileServiceLifecycle({
      relayName: options.relay,
      env: environment?.env,
    });
    if (action === "stop") {
      await lifecycle.stop();
      result = { status: "stopped" };
    } else {
      const expectedSessionIds =
        action === "restart"
          ? readLiveLocalPtySessionIds(SESSIONS_PATH, SESSION_RUNTIME_IPC_VERSION_PATH, {
              terminal: TERMINAL_IPC_PROTOCOL_VERSION,
              worker: WORKER_IPC_PROTOCOL_VERSION,
            })
          : [];
      const { service } =
        action === "restart"
          ? await lifecycle.restart(options.ifRunning ? "recover" : "explicit")
          : await lifecycle.start("explicit", options.recoverFrom);
      const missingSessionIds = await waitForSessionHandover({
        expectedSessionIds,
        loadActiveSessionIds: async () =>
          (await lifecycle.status())?.info?.sessions.map((s) => s.id) ?? null,
        timeoutMs: 10_000,
      });
      result = {
        status: "ready",
        pid: service.pid,
        instanceId: service.instanceId,
        version: service.version,
        missingSessionIds,
      };
    }
  } catch (error) {
    result = {
      status: "failed",
      code: error instanceof ServiceLifecycleError ? error.code : "COMMAND_FAILED",
      message: getErrorMessage(error),
      ...(error instanceof ServiceLifecycleError && error.recoveryToken
        ? { recoveryToken: error.recoveryToken }
        : {}),
    };
  }
  if (options.json) console.log(JSON.stringify(result));
  else if (result.status === "failed") console.error(result.message);
  else if (result.status === "stopped") console.log("Service stopped");
  else {
    console.log(`Service ready (PID ${result.pid})`);
    if (result.missingSessionIds.length) {
      console.error(
        `Service restarted, but ${result.missingSessionIds.length} 个本地终端会话尚未重新连接：${result.missingSessionIds.join(", ")}`,
      );
    }
  }
  if (
    result.status === "failed" ||
    (result.status === "ready" && result.missingSessionIds.length)
  ) {
    process.exitCode = 1;
  }
}

const program = new Command("dev-anywhere")
  .description("Dev Anywhere - transparent local AI CLI proxy with remote control")
  .version(PROXY_VERSION, "-v, --version")
  .option("--profile <name>", "Use an isolated local proxy profile")
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async () => {
    if (!isInitialized()) {
      console.error(`Dev Anywhere is not initialized. Run "dev-anywhere init" first.`);
      process.exit(1);
    }
    // 参数校验放在 dynamic import 之前：错误参数路径不应触发 terminal 模块加载，
    // 避免无谓地拉起 PTY/xterm/logger 这些重资源（也避免 logger 文件 IO 副作用）。
    let invocation: ReturnType<typeof extractAgentInvocation>;
    try {
      invocation = extractAgentInvocation(cliArgsWithoutProfile);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    // 延迟导入 terminal: CLI 的其他子命令（init/stop/status）不需要 PTY + xterm 相关依赖，
    // tsup 基于 dynamic import 自动代码分裂，避免所有命令都为 terminal 付出 14KB 额外启动成本。
    const { startTerminal } = await import("./terminal.js");
    const { provider, args } = invocation;
    await startTerminal(args, provider);
  });

// serve 子命令组
const serve = new Command("serve")
  .description("Manage the dev-anywhere background service")
  .option("--profile <name>", "Use an isolated local proxy profile")
  .option("-d, --daemon", "Run in background")
  .action(async (opts) => {
    if (!isInitialized()) {
      console.error(`Dev Anywhere is not initialized. Run "dev-anywhere init" first.`);
      process.exit(1);
    }
    if (opts.daemon) {
      setDesiredDaemonRelay(undefined);
      await runServiceCommand("start", {});
    } else {
      try {
        await createProfileServiceLifecycle().startForeground(async () => {
          const { startService } = await import("./serve.js");
          await startService();
        });
      } catch (error) {
        console.error(getErrorMessage(error));
        process.exit(1);
      }
    }
  });

serve
  .command("start")
  .description("Start the background service")
  .option("--relay <name>", "Use a named relay from config")
  .option("--json", "Print a machine-readable result")
  .option("--recover-from <token>", "Resume only the specified failed restart")
  .action(async (opts) => {
    if (!isInitialized()) {
      console.error('Dev Anywhere is not initialized. Run "dev-anywhere init" first.');
      process.exitCode = 1;
      return;
    }
    await runServiceCommand("start", opts);
  });

serve
  .command("status")
  .description("Show service status and active sessions")
  .option("-w, --watch", "Continuous monitoring mode")
  .option("-n, --interval <seconds>", "Refresh interval in seconds", "2")
  .action(async (opts) => {
    if (opts.watch) {
      const intervalMs = Number(opts.interval) * 1000;
      let lastLines = await showStatus();
      setInterval(async () => {
        if (lastLines > 0) {
          process.stdout.write(`\x1B[${lastLines}A\x1B[J`);
        }
        lastLines = await showStatus();
      }, intervalMs);
    } else {
      await showStatus();
    }
  });

serve
  .command("stop")
  .description("Stop the background service")
  .option("--json", "Print a machine-readable result")
  .action(async (opts) => runServiceCommand("stop", opts));

serve
  .command("restart")
  .description("Restart the background service")
  .option("--relay <name>", "Use a named relay from config")
  .option("--json", "Print a machine-readable result")
  .option("--if-running", "Do not restart a service that was explicitly stopped")
  .action(async (opts) => runServiceCommand("restart", opts));

program.addCommand(serve);

const autostart = serve.command("autostart").description("Start Proxy automatically at user login");
for (const [action, description] of [
  ["enable", "Enable automatic startup at login"],
  ["disable", "Disable automatic startup without stopping Proxy"],
  ["status", "Show automatic startup status"],
] as const) {
  autostart
    .command(action)
    .description(description)
    .action(async () => {
      const { runAutostartCommand } = await import("./autostart.js");
      await runAutostartCommand(action);
    });
}
autostart
  .command("run", { hidden: true })
  .option("--daemon", "Detach after service readiness (systemd login trigger)")
  .action(async (_options, command: Command) => {
    const { startAutostartService } = await import("./autostart.js");
    await startAutostartService(Boolean(command.optsWithGlobals().daemon));
  });

const relay = new Command("relay").description("Inspect and manage relay configuration");

relay
  .command("token")
  .description("Print the relay's current client token (auth: proxy token)")
  .option("--relay <name>", "Use a named relay from config")
  .action(async (opts) => {
    if (!isInitialized()) {
      console.error(`Dev Anywhere is not initialized. Run "dev-anywhere init" first.`);
      process.exit(1);
    }
    const { runRelayTokenCommand } = await import("./relay-token.js");
    await runRelayTokenCommand({ relayName: opts.relay });
  });

program.addCommand(relay);

program
  .command("tunnel")
  .description("Start a temporary account-free Cloudflare Quick Tunnel")
  .option("--cloudflared <path>", "Path to the cloudflared executable", "cloudflared")
  .action(async (opts) => {
    if (!isInitialized()) {
      initWorkspace();
      console.log(`Initialized ${CONFIG_PATH}`);
    }
    const { runQuickTunnel } = await import("./quick-tunnel.js");
    try {
      await runQuickTunnel({ cloudflaredBin: opts.cloudflared });
    } catch (error) {
      console.error(
        `Quick Tunnel failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    }
  });

program
  .command("init")
  .description("Initialize dev-anywhere workspace (~/.dev-anywhere)")
  .action(() => {
    if (isInitialized()) {
      console.log(`Already initialized. Config at ${CONFIG_PATH}`);
      return;
    }
    initWorkspace();
    console.log("Initialized ~/.dev-anywhere/");
    console.log(`Edit ${CONFIG_PATH} to configure relay server URL.`);
  });

// pnpm run dev -- args 会在参数前插入 "--"。根脚本和用户命令都可能再加一层
// 分隔符，所以这里过滤所有前导分隔符，再交给 Commander 和 provider 参数解析。
const cliArgs = normalizeCliArgs(process.argv.slice(2));
const cliArgsWithoutProfile = stripProxyProfileArgs(cliArgs);

// Commander actions are asynchronous (daemon readiness, lifecycle lock acquisition, graceful
// teardown). Await them so the public CLI exit code is decided only after the complete operation,
// rather than relying on incidental open handles to keep Node alive.
await program.parseAsync(cliArgsWithoutProfile, { from: "user" });
