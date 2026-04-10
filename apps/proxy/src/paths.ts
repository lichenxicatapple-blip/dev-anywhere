import { existsSync, mkdirSync, writeFileSync } from "node:fs";

// 所有 cc-anywhere 文件路径的集中定义
const CC_DIR = `${process.env.HOME}/.cc-anywhere`;
export const CONFIG_PATH = `${CC_DIR}/config.json`;

// 运行时文件
export const RUN_DIR = `${CC_DIR}/run`;
export const SOCK_PATH = `${RUN_DIR}/cc-anywhere.sock`;
export const PID_PATH = `${RUN_DIR}/cc-anywhere.pid`;
export const STOPPED_PATH = `${RUN_DIR}/stopped`;

// 持久化状态
export const STATE_DIR = `${CC_DIR}/state`;
export const SESSIONS_PATH = `${STATE_DIR}/sessions.json`;
export const LASTSEQ_PATH = `${STATE_DIR}/lastseq.json`;

// 会话数据
export const DATA_DIR = `${CC_DIR}/data`;

// 日志
export const LOG_PATH = `${CC_DIR}/service.log`;

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
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, DEFAULT_CONFIG);
  }
}

export function ensureDirectories(): void {
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
}
