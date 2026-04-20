import { existsSync, mkdirSync, writeFileSync } from "node:fs";

// 所有 cc-anywhere 文件路径的集中定义
const CC_DIR = `${process.env.HOME}/.cc-anywhere`;
export const CONFIG_PATH = `${CC_DIR}/config.json`;

// 运行时文件
const RUN_DIR = `${CC_DIR}/run`;
export const SOCK_PATH = `${RUN_DIR}/cc-anywhere.sock`;
export const PID_PATH = `${RUN_DIR}/cc-anywhere.pid`;
// STOPPED_PATH: 布尔标记文件（存在即为真），用于表达"用户主动停 daemon"这一意图。
// 不变量：文件存在时，terminal 必须 NOT 自动 spawn serve。文件不存在时，terminal 可以自动 spawn。
// 写入：stopService (index.ts) —— kill 完 daemon 后创建。
// 删除：startDaemon (index.ts)、ensureService (terminal.ts)、startService (serve.ts)。
// 读取：reconnectToServe (terminal.ts) —— 决定重连时只 tryConnect 还是 ensureService。
// 任何新增的 daemon 启停入口都必须维护此不变量，否则"用户 stop 之后被意外拉活"的回归会复现。
export const STOPPED_PATH = `${RUN_DIR}/stopped`;

// 持久化状态
const STATE_DIR = `${CC_DIR}/state`;
export const SESSIONS_PATH = `${STATE_DIR}/sessions.json`;

// 会话数据
export const DATA_DIR = `${CC_DIR}/data`;

// 日志
export const LOG_DIR = `${CC_DIR}/logs`;
export const LOG_PATH = `${LOG_DIR}/service.log`;

export function sessionDir(sessionId: string): string {
  return `${DATA_DIR}/${sessionId}`;
}

export function sessionPaths(sessionId: string) {
  const dir = sessionDir(sessionId);
  return {
    dir,
    events: `${dir}/events.bin`,
    workerSock: `${dir}/worker.sock`,
  };
}

export function isInitialized(): boolean {
  return existsSync(CONFIG_PATH);
}

const DEFAULT_CONFIG = `{
  "relayUrl": "ws://localhost:3100"
}
`;

export function initWorkspace(): void {
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, DEFAULT_CONFIG);
  }
}

export function ensureDirectories(): void {
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}
