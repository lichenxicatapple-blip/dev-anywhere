import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import {
  PID_PATH,
  SOCK_PATH,
  STOPPED_PATH,
  SERVICE_LOG_PATH,
  CONFIG_PATH,
  PROFILE_NAME,
  ensureProfileWorkspace,
  isInitialized,
  initWorkspace,
} from "./common/paths.js";
import { spawnScript } from "./common/env.js";
import { daemonRelayArgs, setDesiredDaemonRelay } from "./common/daemon-env.js";
import { createIpcReader, serializeIpc } from "./ipc/ipc-protocol.js";
import { extractAgentInvocation, normalizeCliArgs, stripProxyProfileArgs } from "./cli-args.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
  version: string;
};

function stopService(): boolean {
  if (!existsSync(PID_PATH)) {
    console.error("Service is not running (no PID file)");
    return false;
  }
  const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Service stopped (PID ${pid})`);
  } catch {
    console.error(`Process ${pid} not found, cleaning up stale files`);
  }
  if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
  if (existsSync(SOCK_PATH)) unlinkSync(SOCK_PATH);
  writeFileSync(STOPPED_PATH, String(Date.now()));
  return true;
}

function showStatus(): Promise<number> {
  return new Promise((resolve) => {
    let lines = 0;
    const log = (s: string) => {
      console.log(s);
      lines++;
    };

    if (!existsSync(PID_PATH)) {
      log(`Profile: ${PROFILE_NAME}`);
      log("Service: not running");
      resolve(lines);
      return;
    }
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      // process.kill(pid, 0) 抛错表示进程不存在
    }

    if (!alive) {
      log("Service: dead (stale PID file)");
      resolve(lines);
      return;
    }

    log(`Profile: ${PROFILE_NAME}`);
    log(`Service: running (PID ${pid})`);
    log(`Socket:  ${SOCK_PATH}`);
    log(`Log:     ${SERVICE_LOG_PATH}`);

    const sock = connect(SOCK_PATH);
    sock.on("error", () => {
      log("Sessions: unable to connect");
      sock.destroy();
      resolve(lines);
    });
    sock.on("connect", () => {
      createIpcReader(sock, (msg) => {
        if (msg.type === "service_status_response") {
          const config = msg.config;
          log(`Daemon:  profile ${config.profile ?? PROFILE_NAME}`);
          log(`Relay:   ${config.relayName} (${config.relayNameSource})`);
          log(`Config:  relay ${config.relayUrl ?? "(unset)"} (${config.relayUrlSource})`);
          const relay = msg.relay;
          if (!relay) {
            log("Relay:   not configured");
          } else if (relay.connected) {
            log(`Relay:   connected (proxy: ${relay.proxyId})`);
            log(
              `         queue depth: ${relay.queueDepth}, reconnect attempts: ${relay.reconnectAttempt}`,
            );
          } else {
            log(
              `Relay:   disconnected (proxy: ${relay.proxyId}, reconnecting: attempt ${relay.reconnectAttempt}, queued: ${relay.queueDepth})`,
            );
          }
          log("");

          // 显示会话列表
          const sessions = msg.sessions;
          if (sessions.length === 0) {
            log("Sessions: none");
          } else {
            log(`Sessions: ${sessions.length}`);
            for (const s of sessions) {
              log(`  ${s.id}  ${s.mode}  ${s.state}  worker: ${s.hasWorker ? "yes" : "no"}`);
            }
          }
          sock.destroy();
          resolve(lines);
        }
      });
      sock.write(serializeIpc({ type: "service_status_request" }));
    });
  });
}

const DAEMON_STARTUP_TIMEOUT_MS = 30_000;
const DAEMON_STARTUP_POLL_MS = 200;

// 轮询 SOCK_PATH 直到可连接，作为 serve 的 readiness 信号。
// serve.ts 里 server.listen(SOCK_PATH) 是启动序列的最后一步，连上即代表 ready。
async function waitForServeReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const sock = connect(SOCK_PATH);
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("error", () => resolve(false));
    });
    if (connected) return true;
    await sleep(DAEMON_STARTUP_POLL_MS);
  }
  return false;
}

async function startDaemon(options?: { relayName?: string }): Promise<void> {
  ensureProfileWorkspace();
  if (existsSync(PID_PATH)) {
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      console.error(`Service is already running (PID ${pid})`);
      return;
    } catch {
      // process.kill(pid, 0) 抛错表示进程不存在，继续启动
    }
  }
  if (existsSync(STOPPED_PATH)) unlinkSync(STOPPED_PATH);

  // stderr 走 pipe 由父 CLI 订阅：子进程 ready 前（pino logger 未接管）的启动错误
  // 会被捕获；ready 后父 detach，pino 接管所有输出到 service.log。
  // start 命令必须等 daemon socket 可连接后再退出；否则用户会看到“启动成功”，实际服务还没就绪。
  const serveArgs = ["--profile", PROFILE_NAME, ...daemonRelayArgs(options?.relayName)];
  const child = spawnScript(new URL("./serve", import.meta.url), serveArgs, {
    env: { ...process.env },
    stdio: ["ignore", "ignore", "pipe"],
    unref: false,
  });

  const stderrChunks: Buffer[] = [];
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  // race: readiness handshake vs. 子进程先挂。子进程 ready 前就 exit 说明启动硬失败，
  // 不必再等到 30s 超时才报错。
  type Outcome =
    | { kind: "ready" }
    | { kind: "timeout" }
    | { kind: "exited"; code: number | null; signal: NodeJS.Signals | null };

  const readyOutcome: Promise<Outcome> = waitForServeReady(DAEMON_STARTUP_TIMEOUT_MS).then((ok) =>
    ok ? { kind: "ready" as const } : { kind: "timeout" as const },
  );
  const exitOutcome: Promise<Outcome> = new Promise((resolve) => {
    // 设 listener 前已经 exit 的边界：Node 记在 exitCode 上
    if (child.exitCode !== null) {
      resolve({ kind: "exited", code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once("exit", (code, signal) => resolve({ kind: "exited", code, signal }));
  });

  const result = await Promise.race([readyOutcome, exitOutcome]);

  if (result.kind === "ready") {
    console.log(`Service started in background (PID ${child.pid})`);
    // ready 后 detach：摘 stderr 订阅 + destroy pipe + unref 子进程。
    // 单独 child.unref() 不够，父侧的 stderr pipe fd 还在事件循环里会让父 CLI 永不退出；
    // 必须 destroy 掉 pipe 才能真正释放 refcount。pino 已接管子进程的输出到 service.log。
    child.stderr!.removeAllListeners("data");
    child.stderr!.destroy();
    child.unref();
    return;
  }

  // 失败路径：timeout 或 exited
  const stderrOutput = Buffer.concat(stderrChunks).toString("utf-8").trim();
  if (result.kind === "exited") {
    console.error(`Service exited during startup (code=${result.code}, signal=${result.signal}).`);
  } else {
    console.error(`Service failed to become ready within ${DAEMON_STARTUP_TIMEOUT_MS / 1000}s.`);
    try {
      process.kill(child.pid!, "SIGTERM");
    } catch {
      // 子进程可能已自己退出，kill 失败不影响后续退出码
    }
  }
  if (stderrOutput) {
    console.error("--- child stderr ---");
    console.error(stderrOutput);
  }
  process.exit(1);
}

const program = new Command("dev-anywhere")
  .description("Dev Anywhere - transparent local AI CLI proxy with remote control")
  .version(pkg.version)
  .option("--profile <name>", "Use an isolated local proxy profile")
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async () => {
    if (!isInitialized()) {
      console.error(`Dev Anywhere is not initialized. Run "dev-anywhere init" first.`);
      process.exit(1);
    }
    // 延迟导入 terminal: CLI 的其他子命令（init/stop/status）不需要 PTY + xterm 相关依赖，
    // tsup 基于 dynamic import 自动代码分裂，避免所有命令都为 terminal 付出 14KB 额外启动成本。
    const { startTerminal } = await import("./terminal.js");
    let invocation: ReturnType<typeof extractAgentInvocation>;
    try {
      invocation = extractAgentInvocation(cliArgsWithoutProfile);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
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
      await startDaemon();
    } else {
      // 延迟导入 serve: daemon 模式只需要 startDaemon（纯 spawn），不需要加载 70KB 的 serve bundle
      const { startService } = await import("./serve.js");
      await startService();
    }
  });

serve
  .command("start")
  .description("Start the background service")
  .option("--relay <name>", "Use a named relay from config")
  .action(async (opts) => {
    if (!isInitialized()) {
      console.error(`Dev Anywhere is not initialized. Run "dev-anywhere init" first.`);
      process.exit(1);
    }
    setDesiredDaemonRelay(opts.relay);
    await startDaemon({ relayName: opts.relay });
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
  .action(() => {
    stopService();
  });

serve
  .command("restart")
  .description("Restart the background service")
  .option("--relay <name>", "Use a named relay from config")
  .action(async (opts) => {
    setDesiredDaemonRelay(opts.relay);
    stopService();
    await startDaemon({ relayName: opts.relay });
  });

program.addCommand(serve);

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

program.parse(cliArgsWithoutProfile, { from: "user" });
