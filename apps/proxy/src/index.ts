import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { startClient } from "./client.js";
import { startService } from "./serve.js";
import {
  PID_PATH,
  SOCK_PATH,
  STOPPED_PATH,
  LOG_PATH,
  DATA_DIR,
} from "./paths.js";
import { createIpcReader, serializeIpc } from "./ipc-protocol.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
    } catch {}

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
        if (msg.type === "session_list_response") {
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
      sock.write(serializeIpc({ type: "session_list_request" }));
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
    } catch {}
  }
  if (existsSync(STOPPED_PATH)) unlinkSync(STOPPED_PATH);
  const servePath = join(__dirname, "serve.js");
  const child = spawn(process.execPath, [servePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  console.log(`Service started in background (PID ${child.pid})`);
}

// serve 子命令组
const serve = new Command("serve")
  .description("Manage the cc-anywhere background service")
  .option("-d, --daemon", "Run in background")
  .action(async (opts) => {
    if (opts.daemon) {
      await startDaemon();
    } else {
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

// 路由：serve 开头走 Commander，其他全部透传给 claude
if (process.argv[2] === "serve") {
  serve.parse(process.argv.slice(3), { from: "user" });
} else {
  await startClient(process.argv.slice(2));
}
