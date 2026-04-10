import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { startTerminal } from "./terminal.js";
import { startService } from "./serve.js";
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

// ---------- record ----------

serve
  .command("record <outputPath>")
  .description("Record PTY data chunks to NDJSON file for test fixtures")
  .action(async (outputPath: string) => {
    const { resolve } = await import("node:path");
    const { createRecordingTap } = await import("./tap.js");
    const { PtyManager } = await import("./pty-manager.js");
    const { TerminalTracker } = await import("./terminal-tracker.js");

    const absPath = resolve(outputPath);
    const { tap: recordTap, writeResize, stop: stopRecording } = createRecordingTap(absPath);
    const cols = process.stdout.columns ?? 120;
    const rows = process.stdout.rows ?? 40;
    const tracker = new TerminalTracker(cols, rows);

    // 录制初始终端尺寸
    writeResize(cols, rows);

    const ptyManager = new PtyManager({
      claudeArgs: [],
      tap: (data: string) => {
        recordTap(data);
        tracker.feed(data);
      },
      stdin: process.stdin,
      stdout: process.stdout,
      onResize: (newCols, newRows) => {
        writeResize(newCols, newRows);
        tracker.resize(newCols, newRows);
      },
      onSessionExit: (code: number) => {
        stopRecording();
        tracker.dispose();
        console.error(`\nRecording saved to ${absPath}`);
        process.exit(code);
      },
    });

    ptyManager.start();
  });

// 在新终端窗口中执行命令，和当前工作终端完全隔离
function openInNewWindow(args: string[]): void {
  const scriptPath = join(__dirname, "index.js");
  const cmd = `${process.execPath} ${scriptPath} serve ${args.join(" ")}`;
  const termProgram = process.env.TERM_PROGRAM;

  if (termProgram === "iTerm.app") {
    execSync(`osascript -e 'tell application "iTerm2" to create window with default profile command "${cmd}"'`);
  } else if (termProgram === "Apple_Terminal") {
    execSync(`osascript -e 'tell application "Terminal" to do script "${cmd}"'`);
  } else {
    console.error(`Unsupported terminal: ${termProgram ?? "unknown"}. Requires iTerm2 or Terminal.app on macOS.`);
    process.exit(1);
  }
  console.log("Replay opened in new window.");
}

serve
  .command("replay-e2e <fixturePath>")
  .description("Full-chain terminal frame replay for E2E verification")
  .option("-s, --speed <multiplier>", "Playback speed (0=instant, default 1)", "1")
  .option("--remote", "Render via frame pipeline (simulates remote client view)")
  .action(async (fixturePath: string, opts: { speed: string; remote?: boolean }) => {
    const { resolve } = await import("node:path");
    const absPath = resolve(fixturePath);
    const args = ["__replay-e2e", absPath, "-s", opts.speed];
    if (opts.remote) args.push("--remote");
    openInNewWindow(args);
  });

// 新窗口中实际执行的回放逻辑（hidden command）
serve
  .command("__replay-e2e <fixturePath>", { hidden: true })
  .option("-s, --speed <multiplier>", "Playback speed (0=instant, default 1)", "1")
  .option("--remote", "Render via frame pipeline")
  .action(async (fixturePath: string, opts: { speed: string; remote?: boolean }) => {
    const { runReplayE2E } = await import("./replay-e2e.js");
    await runReplayE2E(fixturePath, { speed: Number(opts.speed), remote: opts.remote });
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
