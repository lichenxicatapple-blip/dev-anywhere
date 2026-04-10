/**
 * 全链路终端帧回放验证工具
 *
 * 走完整生产代码路径：
 * NDJSON fixture → PtyManager.startFromFixture → tap → TerminalTracker →
 * createFramePusher(200ms) → IPC pty_terminal_frame → serve.ts → RelayConnection →
 * relay server → WebSocket client → TerminalFrameRenderer → 终端 ANSI 渲染
 *
 * 用法：
 *   cc-anywhere serve replay-e2e <fixture-path> [-s speed]
 *
 * 说明：
 * - 在独立终端窗口中运行，和工作终端完全隔离
 * - 自动启动本地 relay server 和真实 serve.ts
 * - terminal 端通过 IPC 连接 serve，使用 createFramePusher（和 terminal.ts 共用）
 * - test client 通过 WebSocket 从 relay 接收帧，用 TerminalFrameRenderer 渲染
 * - 唯一替换的是数据源：fixture 文件代替 PTY 进程
 *
 * 回放控制：[space]=暂停/恢复  [+/-]=加减速  [q]=退出
 */

import { connect, type Socket } from "node:net";
import { WebSocket } from "ws";
import pino from "pino";
import type { DataTap } from "./tap.js";
import { PtyManager } from "./pty-manager.js";
import { TerminalTracker } from "./terminal-tracker.js";
import { SOCK_PATH } from "./paths.js";
import { createIpcReader, serializeIpc, type IpcMessage } from "./ipc-protocol.js";
import { createFramePusher } from "./frame-pusher.js";
import {
  TerminalFrameRenderer,
  renderViewportToTerminal,
  type TerminalFrame,
} from "./terminal-frame-renderer.js";

const logger = pino({ level: "silent" });

function tryConnect(sockPath: string): Promise<Socket | null> {
  return new Promise((resolve) => {
    const s = connect(sockPath);
    s.on("connect", () => resolve(s));
    s.on("error", () => resolve(null));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 过滤会触发终端响应或干扰回放的转义序列
function stripTerminalRequests(data: string): string {
  return data
    .replace(/\x1b\[c/g, "")           // Primary DA
    .replace(/\x1b\[>[0-9]*c/g, "")    // Secondary DA
    .replace(/\x1b\[=c/g, "")          // Tertiary DA
    .replace(/\x1b\[>[0-9]*q/g, "")    // XTVERSION
    .replace(/\x1b\[[0-9]*n/g, "")     // DSR (cursor position etc.)
    .replace(/\x1b\[>[0-9;]*m/g, "")   // Key modifier options
    .replace(/\x1b\[>[0-9;]*u/g, "")   // Key encoding mode
    .replace(/\x1b\[\?[0-9;]*\$/g, "") // DECRQM (mode query)
    .replace(/\x1b\[\?1004[hl]/g, "")  // Focus reporting
    .replace(/\x1b\[\?2004[hl]/g, "")  // Bracketed paste
    .replace(/\x1b\[\?2031[hl]/g, "")  // Key reporting
    .replace(/\x1b\[\?1049[hl]/g, "")  // Alternate screen buffer
    .replace(/\x1b\[\?25[hl]/g, "");   // Cursor show/hide
}

// 等待按键后退出
async function waitForKeyAndExit(rows: number): Promise<never> {
  process.stdout.write("\x1b[?25h");
  process.stdout.write(`\x1b[${rows};1H\x1b[7m Press any key to close \x1b[27m\x1b[K`);
  await new Promise<void>((resolve) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });
  process.exit(0);
}

export async function runReplayE2E(fixturePath: string, initialSpeed = 1): Promise<void> {
  // 设置窗口标题
  process.stdout.write(`\x1b]0;CC Anywhere Replay - ${fixturePath.split("/").pop()}\x07`);

  // === 1. 启动本地 relay ===
  const { createRelayServer } = await import("@cc-anywhere/relay/server");
  const relay = createRelayServer({ port: 0, heartbeatInterval: 60000, logger });
  await new Promise<void>((resolve) => relay.httpServer.listen(0, resolve));
  const addr = relay.httpServer.address();
  const relayPort = typeof addr === "object" && addr !== null ? addr.port : 0;
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  console.error(`Relay started on localhost:${relayPort}`);

  // === 2. 启动真实 serve.ts ===
  process.env.RELAY_URL = relayUrl;
  const { startService } = await import("./serve.js");
  startService();
  let ipcSocket: Socket | null = null;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    ipcSocket = await tryConnect(SOCK_PATH);
    if (ipcSocket) break;
  }
  if (!ipcSocket) {
    console.error("Failed to connect to serve IPC");
    process.exit(1);
  }
  console.error("Connected to serve via IPC");

  // === 3. 通过 IPC 注册 PTY 会话 ===
  const sessionId = `replay-${Date.now()}`;
  const socket = ipcSocket;

  const sessionResponse = await new Promise<IpcMessage>((resolve) => {
    createIpcReader(socket, (msg: IpcMessage) => {
      if (msg.type === "session_create_response") resolve(msg);
    });
    socket.write(serializeIpc({
      type: "session_create_request",
      mode: "pty",
      sessionId,
    }));
  });

  if (sessionResponse.type !== "session_create_response" || sessionResponse.error) {
    console.error("Session creation failed:", sessionResponse);
    process.exit(1);
  }
  const actualSessionId = sessionResponse.sessionId;

  socket.write(serializeIpc({ type: "pty_register", sessionId: actualSessionId }));
  console.error(`PTY session registered: ${actualSessionId}`);

  // === 4. 设置 tracker + 推帧 ===
  const cols = process.stdout.columns ?? 120;
  const rows = process.stdout.rows ?? 40;
  const tracker = new TerminalTracker(cols, rows);

  const pusher = createFramePusher({
    tracker,
    sessionId: actualSessionId,
    sendFrame: (frameJson) => {
      socket.write(serializeIpc({
        type: "pty_terminal_frame",
        sessionId: actualSessionId,
        frame: frameJson,
      }));
    },
  });
  pusher.start();

  // 监听 serve 转发的 terminal_lines_request
  createIpcReader(socket, (msg: IpcMessage) => {
    if (msg.type === "pty_lines_request" && msg.sessionId === actualSessionId) {
      const lines = tracker.extractLines(msg.fromLineId, msg.count);
      const response = {
        type: "terminal_lines_response",
        sessionId: actualSessionId,
        fromLineId: msg.fromLineId,
        oldestLineId: tracker.getOldestLineId(),
        newestLineId: tracker.getNewestLineId(),
        lines,
      };
      socket.write(serializeIpc({
        type: "pty_lines_response",
        sessionId: actualSessionId,
        response: JSON.stringify(response),
      }));
    }
  });

  // === 5. WebSocket 连接 relay 接收帧 ===
  const clientWs = new WebSocket(`${relayUrl}/client`);
  await new Promise<void>((resolve, reject) => {
    clientWs.on("open", resolve);
    clientWs.on("error", reject);
  });

  clientWs.send(JSON.stringify({ type: "client_register", clientId: "replay-viewer" }));
  await sleep(200);

  clientWs.send(JSON.stringify({ type: "proxy_list_request" }));
  const listMsg = await new Promise<string>((resolve) => {
    clientWs.once("message", (data) => resolve(data.toString()));
  });
  const proxyList = JSON.parse(listMsg);
  if (proxyList.type === "proxy_list_response" && proxyList.proxies.length > 0) {
    clientWs.send(JSON.stringify({ type: "proxy_select", proxyId: proxyList.proxies[0].proxyId }));
    await sleep(100);
    console.error(`Client bound to proxy: ${proxyList.proxies[0].proxyId}`);
  } else {
    console.error("No proxy found on relay");
    process.exit(1);
  }

  // TerminalFrameRenderer 处理收到的帧
  const renderer = new TerminalFrameRenderer();
  let frameCount = 0;

  renderer.onUpdate(() => {
    frameCount++;
    renderViewportToTerminal(renderer);
    drawStatusBar();
  });

  clientWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "terminal_frame") {
        renderer.applyFrame(msg as TerminalFrame);
      }
    } catch {
      // ignore non-JSON
    }
  });

  // === 6. 回放控制 ===
  let speed = initialSpeed;
  let paused = false;

  const speedSteps = [0, 0.25, 0.5, 1, 2, 4, 8, 16];

  function nextSpeed(): void {
    const idx = speedSteps.indexOf(speed);
    if (idx < speedSteps.length - 1) speed = speedSteps[idx + 1];
  }

  function prevSpeed(): void {
    const idx = speedSteps.indexOf(speed);
    if (idx > 0) speed = speedSteps[idx - 1];
  }

  function drawStatusBar(): void {
    const termRows = process.stdout.rows ?? 40;
    const pauseLabel = paused ? " PAUSED " : "";
    const speedLabel = speed === 0 ? "instant" : `${speed}x`;
    process.stdout.write(`\x1b[${termRows};1H`);
    process.stdout.write(
      `\x1b[7m Frame #${frameCount} | ${speedLabel}${pauseLabel} | [space]=pause [+/-]=speed [q]=quit \x1b[27m\x1b[K`,
    );
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (key: Buffer) => {
      const ch = key.toString();
      if (ch === " ") {
        paused = !paused;
        drawStatusBar();
      } else if (ch === "+" || ch === "=") {
        nextSpeed();
        drawStatusBar();
      } else if (ch === "-" || ch === "_") {
        prevSpeed();
        drawStatusBar();
      } else if (ch === "q" || ch === "\x03") {
        process.exit(0);
      }
    });
  }

  // === 7. 回放 ===
  const termRows = process.stdout.rows ?? 40;
  process.stdout.write(`\x1b[2J\x1b[H\x1b[?25l\x1b[1;${termRows - 1}r`);

  const tap: DataTap = (data: string) => {
    tracker.feed(data);
  };

  // stdout 输出经过 stripTerminalRequests 过滤，防止干扰回放窗口
  const filteredStdout = new Proxy(process.stdout, {
    get(target, prop) {
      if (prop === "write") {
        return (data: string | Buffer, ...args: unknown[]) => {
          const str = typeof data === "string" ? data : data.toString();
          return target.write(stripTerminalRequests(str), ...args as []);
        };
      }
      return (target as Record<string | symbol, unknown>)[prop];
    },
  }) as unknown as NodeJS.WriteStream;

  const ptyManager = new PtyManager({
    claudeArgs: [],
    tap,
    stdin: process.stdin,
    stdout: filteredStdout,
    onResize: (newCols, newRows) => {
      // resize 回放窗口到录制尺寸，更新 tracker 和滚动区域
      process.stdout.write(`\x1b[8;${newRows};${newCols}t`);
      tracker.resize(newCols, newRows);
      const scrollRows = newRows - 1;
      process.stdout.write(`\x1b[1;${scrollRows}r`);
    },
    onSessionExit: async () => {
      await sleep(500);
      pusher.stop();

      tracker.dispose();
      socket.write(serializeIpc({ type: "pty_deregister", sessionId: actualSessionId }));
      socket.end();
      clientWs.close();
      await relay.close();

      console.error(`Replay complete: ${frameCount} frames received by client`);
      await waitForKeyAndExit(termRows);
    },
  });

  await ptyManager.startFromFixture(fixturePath, {
    isPaused: () => paused,
    getSpeed: () => speed,
  });
}
