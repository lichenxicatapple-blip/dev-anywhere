import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, execSync } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { startClient } from "./client.js";
import { startService } from "./serve.js";
import { EventStore, EventType, decodeSizePayload } from "./event-store.js";
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
    .replace(/\x1b\[\?2031[hl]/g, "")  // Key reporting
    .replace(/\x1b\[\?1049[hl]/g, "")  // Alternate screen buffer
    .replace(/\x1b\[\?25[hl]/g, "");   // Cursor show/hide
}

function sanitizeReplayData(data: string): string {
  return stripTerminalRequests(fixOsc9(data));
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

// 在新终端窗口中执行命令（仅 macOS）
function openInNewWindow(args: string[]): void {
  const scriptPath = join(__dirname, "index.js");
  const cmd = `${process.execPath} ${scriptPath} serve ${args.join(" ")}`;
  const termProgram = process.env.TERM_PROGRAM;

  if (termProgram === "iTerm.app") {
    execSync(`osascript -e 'tell application "iTerm2" to create window with default profile command "${cmd}"'`);
  } else if (termProgram === "Apple_Terminal") {
    execSync(`osascript -e 'tell application "Terminal" to do script "${cmd}"'`);
  } else {
    console.error(`Unsupported terminal: ${termProgram ?? "unknown"}. This command requires macOS with iTerm2 or Terminal.app.`);
    process.exit(1);
  }
}

// 等待按键后退出，rows 由调用方传入确保定位准确
async function waitForKeyAndExit(rows: number): Promise<never> {
  process.stdout.write("\x1b[?25h");
  process.stdout.write(`\x1b[${rows};1H\x1b[7m Press any key to close \x1b[27m`);
  await new Promise<void>((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });
  process.exit(0);
}

// ---------- replay ----------

serve
  .command("replay [sessionId]")
  .description("Replay a session's event log in a new terminal window")
  .option("-s, --speed <multiplier>", "Playback speed multiplier", "1")
  .action((sessionId: string | undefined, opts: { speed: string }) => {
    if (!sessionId) {
      console.log("Available sessions:");
      listSessions();
      console.log("\nUsage: serve replay <sessionId> [-s speed]");
      return;
    }
    // 检查事件文件是否存在
    const store = new EventStore(sessionId);
    if (store.readEvents().length === 0) {
      console.error(`No events found for session: ${sessionId}`);
      return;
    }
    openInNewWindow(["__replay", sessionId, "-s", opts.speed]);
  });

// 实际渲染逻辑，在独立窗口中运行
serve
  .command("__replay <sessionId>", { hidden: true })
  .option("-s, --speed <multiplier>", "Playback speed multiplier", "1")
  .action(async (sessionId: string, opts: { speed: string }) => {
    process.stdout.write(`\x1b]0;CC Anywhere Replay - ${sessionId}\x07`);

    const store = new EventStore(sessionId);
    const events = store.readEvents();
    if (events.length === 0) {
      console.error(`No events found for session: ${sessionId}`);
      process.exit(1);
    }

    // 从事件流中读取初始终端尺寸
    const firstSize = events.find((e) => e.type === EventType.SIZE);
    let termCols = 80;
    let termRows = 24;
    if (firstSize) {
      const decoded = decodeSizePayload(firstSize.payload);
      termCols = decoded.cols;
      termRows = decoded.rows;
    }

    // resize 到录制尺寸，并锁定窗口大小
    let lockedCols = termCols;
    let lockedRows = termRows;
    process.stdout.write(`\x1b[8;${termRows};${termCols}t`);
    await new Promise((r) => setTimeout(r, 150));
    process.stdout.on("resize", () => {
      process.stdout.write(`\x1b[8;${lockedRows};${lockedCols}t`);
    });

    const speed = Number(opts.speed);
    const pkg = await import("@xterm/headless");
    const serializePkg = await import("@xterm/addon-serialize");
    const term = new pkg.default.Terminal({ cols: termCols, rows: termRows, allowProposedApi: true });
    const ser = new serializePkg.default.SerializeAddon();
    term.loadAddon(ser);

    // 逐行定位 + 清除 + 写入，每帧都清除内容以下的残留行
    function renderFrame(clear = false): void {
      const serialized = sanitizeReplayData(ser.serialize({ scrollback: 0 }));
      const lines = serialized.replace(/[\r\n]+$/, "").split(/\r?\n/);
      const totalRows = process.stdout.rows ?? lines.length;
      let buf = "";
      for (let i = 0; i < lines.length; i++) {
        buf += `\x1b[${i + 1};1H\x1b[2K${lines[i]}`;
      }
      // 清除内容以下的所有行
      for (let i = lines.length; i < totalRows; i++) {
        buf += `\x1b[${i + 1};1H\x1b[2K`;
      }
      if (clear) {
        buf += "\x1b[3J";
      }
      process.stdout.write(buf);
    }

    let aborted = false;
    process.on("SIGINT", () => {
      aborted = true;
      term.dispose();
      process.exit(0);
    });

    process.stdout.write("\x1b[?25l");
    renderFrame(true);

    for (let i = 0; i < events.length && !aborted; i++) {
      const event = events[i];
      if (event.type === EventType.PTY_OUTPUT) {
        await new Promise<void>((r) => term.write(event.payload.toString(), r));
      } else if (event.type === EventType.SIZE) {
        const decoded = decodeSizePayload(event.payload);
        term.resize(decoded.cols, decoded.rows);
        lockedCols = decoded.cols;
        lockedRows = decoded.rows;
        process.stdout.write(`\x1b[8;${decoded.rows};${decoded.cols}t`);
        await new Promise((r) => setTimeout(r, 150));
        renderFrame(true);
      }

      const nextEvent = events[i + 1];
      if (nextEvent) {
        const delay = (nextEvent.ts - event.ts) / speed;
        if (delay > 50) {
          renderFrame();
          if (delay > 0 && delay < 5000) {
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
    }

    renderFrame();
    term.dispose();
    await waitForKeyAndExit(lockedRows);
  });

// ---------- snapshot ----------

serve
  .command("snapshot [sessionId]")
  .description("Display terminal snapshot in a new terminal window")
  .option("--restore", "Apply post-snapshot events to show current state")
  .action((sessionId: string | undefined, opts: { restore?: boolean }) => {
    if (!sessionId) {
      console.log("Available sessions:");
      listSessions();
      console.log("\nUsage: serve snapshot <sessionId> [--restore]");
      return;
    }
    const store = new EventStore(sessionId);
    if (!store.getLatestSnapshot()) {
      console.error(`No snapshot found for session: ${sessionId}`);
      return;
    }
    const args = ["__snapshot", sessionId];
    if (opts.restore) args.push("--restore");
    openInNewWindow(args);
  });

serve
  .command("__snapshot <sessionId>", { hidden: true })
  .option("--restore", "Apply post-snapshot events")
  .action(async (sessionId: string, opts: { restore?: boolean }) => {
    process.stdout.write(`\x1b]0;CC Anywhere Snapshot - ${sessionId}\x07`);

    const store = new EventStore(sessionId);
    const snapshot = store.getLatestSnapshot();
    if (!snapshot) {
      console.error(`No snapshot found for session: ${sessionId}`);
      process.exit(1);
    }

    // snapshot payload 前 4 字节是 size header (cols + rows)
    const snapCols = snapshot.payload.readUInt16LE(0);
    const snapRows = snapshot.payload.readUInt16LE(2);
    const snapContent = snapshot.payload.subarray(4).toString();

    // resize 到快照尺寸，并锁定窗口大小
    let lockedCols = snapCols;
    let lockedRows = snapRows;
    process.stdout.write(`\x1b[8;${snapRows};${snapCols}t`);
    await new Promise((r) => setTimeout(r, 150));
    process.stdout.on("resize", () => {
      process.stdout.write(`\x1b[8;${lockedRows};${lockedCols}t`);
    });

    let output: string;

    if (opts.restore) {
      const postEvents = store.readEvents(snapshot.seq);
      const pkg = await import("@xterm/headless");
      const serializePkg = await import("@xterm/addon-serialize");
      const term = new pkg.default.Terminal({ cols: snapCols, rows: snapRows, allowProposedApi: true });
      const ser = new serializePkg.default.SerializeAddon();
      term.loadAddon(ser);

      await new Promise<void>((r) => term.write(snapContent, r));
      for (const event of postEvents) {
        if (event.type === EventType.PTY_OUTPUT) {
          await new Promise<void>((r) => term.write(event.payload.toString(), r));
        } else if (event.type === EventType.SIZE) {
          const decoded = decodeSizePayload(event.payload);
          term.resize(decoded.cols, decoded.rows);
          lockedCols = decoded.cols;
          lockedRows = decoded.rows;
          process.stdout.write(`\x1b[8;${decoded.rows};${decoded.cols}t`);
          await new Promise((r) => setTimeout(r, 150));
        }
      }
      output = sanitizeReplayData(ser.serialize({ scrollback: 0 }));
      term.dispose();
    } else {
      output = sanitizeReplayData(snapContent);
    }

    process.stdout.write("\x1b[H\x1b[J");
    process.stdout.write(output.replace(/[\r\n]+$/, ""));
    await waitForKeyAndExit(lockedRows);
  });

// 路由：serve 开头走 Commander，其他全部透传给 claude
if (process.argv[2] === "serve") {
  serve.parse(process.argv.slice(3), { from: "user" });
} else {
  await startClient(process.argv.slice(2));
}
