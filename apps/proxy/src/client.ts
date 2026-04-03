import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { DataTap } from "./tap.js";
import { PtyManager } from "./pty-manager.js";
import {
  createIpcReader,
  serializeIpc,
  type IpcMessage,
} from "./ipc-protocol.js";

const CC_DIR = `${process.env.HOME}/.cc-anywhere`;
const SOCK_PATH = `${CC_DIR}/cc-anywhere.sock`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// 自动启动 service 进程并等待连接就绪
async function ensureService(): Promise<Socket> {
  const existing = await tryConnect(SOCK_PATH);
  if (existing) return existing;

  // 启动 service 子进程，detached + unref 使其独立运行
  const servePath = join(__dirname, "serve.js");
  const child = spawn(process.execPath, [servePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // 轮询等待 service 就绪，指数退避上限 2s
  const maxRetries = 20;
  for (let i = 0; i < maxRetries; i++) {
    const delay = Math.min(100 * (i + 1), 2000);
    await sleep(delay);
    const socket = await tryConnect(SOCK_PATH);
    if (socket) return socket;
  }

  throw new Error(
    `Failed to connect to cc-anywhere service after ${maxRetries} retries. Check ${CC_DIR}/service.log for details.`,
  );
}

// 等待特定类型的 IPC 响应
function waitForMessage(
  socket: Socket,
  messageType: string,
): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${messageType}`));
    }, 10000);

    createIpcReader(socket, (msg: IpcMessage) => {
      if (msg.type === messageType) {
        clearTimeout(timeout);
        resolve(msg);
      }
    });
  });
}

export async function startClient(claudeArgs: string[]): Promise<void> {
  const socket = await ensureService();

  // 请求创建 PTY 会话
  const responsePromise = waitForMessage(socket, "session_create_response");
  socket.write(
    serializeIpc({ type: "session_create_request", mode: "pty" }),
  );

  const response = await responsePromise;
  if (response.type !== "session_create_response") {
    throw new Error("Unexpected response type");
  }
  if (response.error) {
    throw new Error(`Failed to create session: ${response.error}`);
  }
  const sessionId = response.sessionId;

  // PTY 输出通过 IPC 转发给 service
  const tap: DataTap = (data: string) => {
    if (socket.writable) {
      socket.write(
        serializeIpc({ type: "pty_output", sessionId, data }),
      );
    }
  };

  let ptyManager: PtyManager | null = null;

  // 处理来自 service 的消息
  createIpcReader(socket, (msg: IpcMessage) => {
    if (msg.type === "pty_input" && msg.sessionId === sessionId) {
      ptyManager?.write(msg.data);
    }
  });

  ptyManager = new PtyManager({
    claudeArgs,
    tap,
    stdin: process.stdin,
    stdout: process.stdout,
    onSessionExit: (code: number) => {
      clearInterval(heartbeatInterval);
      if (socket.writable) {
        socket.write(
          serializeIpc({ type: "pty_deregister", sessionId }),
        );
      }
      socket.end();
      process.exit(code);
    },
  });
  ptyManager.start();

  // 注册 PTY 会话
  socket.write(serializeIpc({ type: "pty_register", sessionId }));

  // 心跳保活
  const heartbeatInterval = setInterval(() => {
    if (socket.writable) {
      socket.write(serializeIpc({ type: "heartbeat", sessionId }));
    }
  }, 10_000);

  // SIGTERM 触发优雅退出，SIGINT 让 PTY 子进程处理
  process.on("SIGTERM", () => {
    clearInterval(heartbeatInterval);
    if (socket.writable) {
      socket.write(serializeIpc({ type: "pty_deregister", sessionId }));
    }
    ptyManager?.cleanup(143);
  });
}
