import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import {
  PID_PATH,
  SOCK_PATH,
  STOPPED_PATH,
  LOG_PATH,
  CONFIG_PATH,
  isInitialized,
  initWorkspace,
} from "./paths.js";
import { createIpcReader, serializeIpc } from "./ipc-protocol.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };

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
    const log = (s: string) => { console.log(s); lines++; };

    if (!existsSync(PID_PATH)) {
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

    log(`Service: running (PID ${pid})`);
    log(`Socket:  ${SOCK_PATH}`);
    log(`Log:     ${LOG_PATH}`);

    const sock = connect(SOCK_PATH);
    sock.on("error", () => {
      log("Sessions: unable to connect");
      resolve(lines);
    });
    sock.on("connect", () => {
      createIpcReader(sock, (msg) => {
        if (msg.type === "service_status_response") {
          // 显示 relay 连接状态
          const relay = msg.relay;
          if (!relay) {
            log("Relay:   not configured");
          } else if (relay.connected) {
            log(`Relay:   connected (proxy: ${relay.proxyId})`);
            log(`         queue depth: ${relay.queueDepth}, reconnect attempts: ${relay.reconnectAttempt}`);
          } else {
            log(`Relay:   disconnected (proxy: ${relay.proxyId}, reconnecting: attempt ${relay.reconnectAttempt}, queued: ${relay.queueDepth})`);
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
        } else if (msg.type === "session_list_response") {
          // 向后兼容：旧版 serve 进程返回 session_list_response
          const sessions = msg.sessions;
          if (sessions.length === 0) {
            log("Sessions: none");
          } else {
            log(`Sessions: ${sessions.length}`);
            for (const s of sessions) {
              log(`  ${s.id}  ${s.mode}  ${s.state}`);
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

async function startDaemon(): Promise<void> {
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
  const isDev = __filename.endsWith(".ts");
  const servePath = join(__dirname, isDev ? "serve.ts" : "serve.js");
  const child = spawn(isDev ? "tsx" : process.execPath, [servePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`Service started in background (PID ${child.pid})`);
}

const program = new Command("cc-anywhere")
  .description("CC Anywhere - transparent Claude Code proxy with remote control")
  .version(pkg.version)
  .allowUnknownOption()
  .allowExcessArguments()
  .action(async () => {
    if (!isInitialized()) {
      console.error(`CC Anywhere is not initialized. Run "cc-anywhere init" first.`);
      process.exit(1);
    }
    const { startTerminal } = await import("./terminal.js");
    await startTerminal(cliArgs);
  });

// serve 子命令组
const serve = new Command("serve")
  .description("Manage the cc-anywhere background service")
  .option("-d, --daemon", "Run in background")
  .action(async (opts) => {
    if (!isInitialized()) {
      console.error(`CC Anywhere is not initialized. Run "cc-anywhere init" first.`);
      process.exit(1);
    }
    if (opts.daemon) {
      await startDaemon();
    } else {
      const { startService } = await import("./serve.js");
      await startService();
    }
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
  .action(async () => {
    stopService();
    await startDaemon();
  });

program.addCommand(serve);

program
  .command("init")
  .description("Initialize cc-anywhere workspace (~/.cc-anywhere)")
  .action(() => {
    if (isInitialized()) {
      console.log(`Already initialized. Config at ${CONFIG_PATH}`);
      return;
    }
    initWorkspace();
    console.log("Initialized ~/.cc-anywhere/");
    console.log(`Edit ${CONFIG_PATH} to configure relay server URL.`);
  });

// pnpm run dev -- args 会在参数前插入 "--"，过滤掉前导分隔符再交给 Commander
const cliArgs = process.argv.slice(2);
if (cliArgs[0] === "--") cliArgs.shift();
program.parse(cliArgs, { from: "user" });
