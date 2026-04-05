import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { startClient } from "./client.js";
import { startService } from "./serve.js";
import { EventStore, EventType } from "./event-store.js";
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

// 还原 PTY onlcr 对 OSC 9 的 \r\n 污染
function fixOsc9(data: string): string {
  return data.replace(
    /\x1b\]9;([\s\S]*?)\x07/g,
    (_, content: string) => `\x1b]9;${content.replace(/\r\n/g, "\n")}\x07`,
  );
}

// 过滤掉所有触发终端响应的序列，防止响应污染 shell
function stripTerminalRequests(data: string): string {
  return data
    // 触发终端响应的请求序列
    .replace(/\x1b\[c/g, "")           // Primary DA
    .replace(/\x1b\[>[0-9]*c/g, "")    // Secondary DA
    .replace(/\x1b\[=c/g, "")          // Tertiary DA
    .replace(/\x1b\[>[0-9]*q/g, "")    // XTVERSION
    .replace(/\x1b\[[0-9]*n/g, "")     // DSR (cursor position etc.)
    .replace(/\x1b\[>[0-9;]*m/g, "")   // Key modifier options
    .replace(/\x1b\[>[0-9;]*u/g, "")   // Key encoding mode
    .replace(/\x1b\[\?[0-9;]*\$/g, "") // DECRQM (mode query)
    // 不影响渲染的输入侧模式，replay 时不应开启
    .replace(/\x1b\[\?1004[hl]/g, "")  // Focus reporting
    .replace(/\x1b\[\?2004[hl]/g, "")  // Bracketed paste
    .replace(/\x1b\[\?2031[hl]/g, ""); // Key reporting
}

function sanitizeReplayData(data: string): string {
  return stripTerminalRequests(fixOsc9(data));
}

// replay 前保存终端状态，replay 后恢复
let savedStty: string | null = null;

function saveTerminalState(): void {
  if (process.platform !== "win32") {
    try {
      savedStty = execSync("stty -g", { encoding: "utf-8" }).trim();
    } catch {}
  }
}

function restoreTerminalState(): void {
  if (process.platform === "win32") {
    process.stdout.write("\x1b[0m\x1b[?25h");
  } else if (savedStty) {
    try {
      execSync(`stty ${savedStty}`, { stdio: "inherit" });
    } catch {}
  }
  process.stdout.write(
    "\x1b[?2004l" +
    "\x1b[?1004l" +
    "\x1b[?2031l" +
    "\x1b[0m" +
    "\x1b[?25h" +
    "\n"
  );
}

function listSessions(): void {
  if (existsSync(DATA_DIR)) {
    const dirs = readdirSync(DATA_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(`${DATA_DIR}/${d.name}/events.bin`));
    if (dirs.length === 0) {
      console.log("  (none)");
    } else {
      for (const d of dirs) {
        console.log(`  ${d.name}`);
      }
    }
  } else {
    console.log("  (none)");
  }
}

serve
  .command("replay [sessionId]")
  .description("Replay a session's event log to terminal")
  .option("-s, --speed <multiplier>", "Playback speed multiplier", "1")
  .action(async (sessionId: string | undefined, opts: { speed: string }) => {
    if (!sessionId) {
      console.log("Available sessions:");
      listSessions();
      console.log("\nUsage: serve replay <sessionId> [-s speed]");
      return;
    }

    const store = new EventStore(sessionId);
    const events = store.readEvents();
    if (events.length === 0) {
      console.error(`No events found for session: ${sessionId}`);
      return;
    }

    const speed = Number(opts.speed);
    saveTerminalState();

    let aborted = false;
    const onSigint = () => {
      aborted = true;
      restoreTerminalState();
      console.log("--- Replay interrupted ---");
      process.exit(0);
    };
    process.on("SIGINT", onSigint);

    console.log(`Replaying ${events.length} events (speed: ${speed}x). Press Ctrl+C to stop.\n`);
    try {
      for (let i = 0; i < events.length && !aborted; i++) {
        const event = events[i];
        if (event.type === EventType.PTY_OUTPUT) {
          process.stdout.write(sanitizeReplayData(event.payload.toString()));
        }
        if (i < events.length - 1) {
          const delay = (events[i + 1].ts - event.ts) / speed;
          if (delay > 0 && delay < 5000) {
            await new Promise(r => setTimeout(r, delay));
          }
        }
      }
    } finally {
      process.removeListener("SIGINT", onSigint);
      restoreTerminalState();
    }
    console.log("--- Replay complete ---");
  });

serve
  .command("snapshot [sessionId]")
  .description("Display terminal snapshot, optionally with post-snapshot events applied")
  .option("--restore", "Apply post-snapshot events to show current state")
  .action(async (sessionId: string | undefined, opts: { restore?: boolean }) => {
    if (!sessionId) {
      console.log("Available sessions:");
      listSessions();
      console.log("\nUsage: serve snapshot <sessionId> [--restore]");
      return;
    }

    const store = new EventStore(sessionId);
    const snapshot = store.getLatestSnapshot();
    if (!snapshot) {
      console.error(`No snapshot found for session: ${sessionId}`);
      return;
    }

    const postEvents = store.readEvents(snapshot.seq);
    const totalEvents = store.getSeq();
    console.log(
      `Snapshot after event #${snapshot.seq - 1} ` +
      `(taken at ${new Date(snapshot.ts).toLocaleString()})` +
      `${postEvents.length > 0 ? `, ${postEvents.length} events since then (latest: #${totalEvents})` : ", up to date"}`
    );

    if (opts.restore && postEvents.length > 0) {
      // 用 xterm-headless 加载快照 + 回放后续事件，输出最终状态
      const pkg = await import("@xterm/headless");
      const serializePkg = await import("@xterm/addon-serialize");
      const term = new pkg.default.Terminal({ cols: 120, rows: 40, allowProposedApi: true });
      const ser = new serializePkg.default.SerializeAddon();
      term.loadAddon(ser);

      await new Promise<void>((r) => term.write(snapshot.payload.toString(), r));
      for (const event of postEvents) {
        if (event.type === EventType.PTY_OUTPUT) {
          await new Promise<void>((r) => term.write(event.payload.toString(), r));
        }
      }

      console.log("(restored with post-snapshot events)\n");
      process.stdout.write(sanitizeReplayData(ser.serialize({ scrollback: 0 })));
      term.dispose();
    } else {
      if (postEvents.length > 0 && !opts.restore) {
        console.log("(showing snapshot only, use --restore to apply newer events)");
      }
      console.log();
      process.stdout.write(sanitizeReplayData(snapshot.payload.toString()));
    }
    console.log("\n\n--- End ---");
  });

// 路由：serve 开头走 Commander，其他全部透传给 claude
if (process.argv[2] === "serve") {
  serve.parse(process.argv.slice(3), { from: "user" });
} else {
  await startClient(process.argv.slice(2));
}
