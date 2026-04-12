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

import { logger } from "./logger.js";

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

function resizeTerminalWindow(cols: number, rows: number): void {
  process.stdout.write(`\x1b[8;${rows};${cols}t`);
}

/* eslint-disable no-control-regex */
// 过滤会触发终端响应或干扰回放的转义序列
function stripTerminalRequests(data: string): string {
  return data
    .replace(/\x1b\[c/g, "")           // Primary DA
    .replace(/\x1b\[>[0-9]*c/g, "")    // Secondary DA
    .replace(/\x1b\[=c/g, "")          // Tertiary DA
    .replace(/\x1b\[>[0-9]*q/g, "")    // XTVERSION
    .replace(/\x1b\[[0-9]*n/g, "")     // DSR
    .replace(/\x1b\[\?[0-9;]*\$/g, "") // DECRQM
    .replace(/\x1b\[\?1004[hl]/g, "")  // Focus reporting
    .replace(/\x1b\[\?2004[hl]/g, "")  // Bracketed paste
    .replace(/\x1b\[\?1049[hl]/g, ""); // Alternate screen buffer
}
/* eslint-enable no-control-regex */

// 更新窗口标题显示完成信息，等待按键后退出
async function waitForKeyAndExit(frameCount: number): Promise<never> {
  process.stdout.write(`\x1b]0;Replay done | ${frameCount} frames | Press any key to close\x07`);
  // 回放结束后内容不再变化，在底部显示提示
  const rows = process.stdout.rows ?? 24;
  const text = ` Replay done | ${frameCount} frames | Press any key to close `;
  const col = (process.stdout.columns ?? 80) - text.length + 1;
  process.stdout.write(
    `\x1b[${rows};1H\x1b[2K` +
    `\x1b[${rows};${col}H` +
    `\x1b[7m${text}\x1b[27m` +
    `\x1b[?25h`,
  );
  await new Promise<void>((resolve) => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });
  process.exit(0);
}

export interface ReplayOptions {
  speed?: number;
  remote?: boolean;
}

export async function runReplayE2E(fixturePath: string, options: ReplayOptions = {}): Promise<void> {
  const { speed: initialSpeed = 1, remote = false } = options;
  const fileName = fixturePath.split("/").pop() ?? fixturePath;

  // === 1. 启动本地 relay ===
  const { createRelayServer } = await import("@cc-anywhere/relay/server");
  const relay = createRelayServer({ port: 0, heartbeatInterval: 60000, logger });
  await new Promise<void>((resolve) => relay.httpServer.listen(0, resolve));
  const addr = relay.httpServer.address();
  const relayPort = typeof addr === "object" && addr !== null ? addr.port : 0;
  const relayUrl = `ws://127.0.0.1:${relayPort}`;
  console.error(`Relay started on localhost:${relayPort}`);

  // === 2. 启动真实 serve.ts ===
  const { startService } = await import("./serve.js");
  startService({ relayUrl });
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
  const cols = process.stdout.columns!;
  const rows = process.stdout.rows!;
  const tracker = new TerminalTracker(cols, rows);
  let claudeTitle = "";
  tracker.onTitleChange = (title) => {
    claudeTitle = title;
    drawStatusBar();
    // 通过 IPC 推送标题变化到 relay
    socket.write(serializeIpc({
      type: "pty_title_change",
      sessionId: actualSessionId,
      title,
    }));
  };

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
    if (remote) renderViewportToTerminal(renderer);
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
    const pauseLabel = paused ? " | PAUSED" : "";
    const speedLabel = speed === 0 ? "instant" : `${speed}x`;
    const mode = remote ? "remote" : "local";
    const titleSuffix = claudeTitle ? ` | ${claudeTitle}` : "";
    process.stdout.write(`\x1b]0;${fileName} | ${speedLabel}${pauseLabel} | ${mode} | [spc]=pause [+/-]=speed [q]=quit | #${frameCount}${titleSuffix}\x07`);
  }

  function cleanup(): void {
    pusher.stop();
    tracker.dispose();
    socket.write(serializeIpc({ type: "pty_deregister", sessionId: actualSessionId }));
    socket.end();
    if (clientWs) clientWs.close();
    if (relay) relay.close();
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
        cleanup();
        process.exit(0);
      }
    });
  }

  // === 7. 回放 ===
  process.stdout.write("\x1b[2J\x1b[H\x1b[?25l");

  const tap: DataTap = (data: string) => {
    tracker.feed(data);
  };

  // 默认：直接路径渲染终端（自然滚动）
  // --remote：静默直接路径，帧管线渲染（模拟远端 client 视角）
  const replayStdout = remote
    ? new Proxy(process.stdout, {
        get(target, prop) {
          if (prop === "write") return () => true;
          return (target as unknown as Record<string | symbol, unknown>)[prop];
        },
      }) as NodeJS.WriteStream
    : new Proxy(process.stdout, {
        get(target, prop) {
          if (prop === "write") {
            return (data: string | Buffer, ...args: unknown[]) => {
              const str = typeof data === "string" ? data : data.toString();
              return target.write(stripTerminalRequests(str), ...args as []);
            };
          }
          return (target as unknown as Record<string | symbol, unknown>)[prop];
        },
      }) as NodeJS.WriteStream;

  const ptyManager = new PtyManager({
    claudeArgs: [],
    tap,
    stdin: process.stdin,
    stdout: replayStdout,
    onResize: (newCols, newRows) => {
      resizeTerminalWindow(newCols, newRows);
      process.stdout.write("\x1b[2J\x1b[H");
      tracker.resize(newCols, newRows);
      drawStatusBar();
    },
    onSessionExit: async () => {
      await sleep(500);
      pusher.flush();
      cleanup();
      await waitForKeyAndExit(frameCount);
    },
  });

  await ptyManager.startFromFixture(fixturePath, {
    isPaused: () => paused,
    getSpeed: () => speed,
  });
}
