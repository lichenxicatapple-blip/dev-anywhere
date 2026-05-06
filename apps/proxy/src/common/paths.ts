import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// 所有 dev-anywhere 文件路径的集中定义
// 使用 os.homedir()：POSIX 走 HOME，Windows 走 USERPROFILE；未设置时回退到 getpwuid。
// 相比 process.env.HOME，不会在缺失环境变量时构造出 "undefined/.dev-anywhere"。
const HOME = homedir();
const APP_DIR = `${HOME}/.dev-anywhere`;

// 把 cwd 前缀替换为 ~，HOME 为空时原样返回（避免 replace("", "~") 把 ~ 前缀到所有路径）
export function tildify(cwd: string): string {
  return HOME ? cwd.replace(HOME, "~") : cwd;
}
export const CONFIG_PATH = `${APP_DIR}/config.json`;

// 运行时文件
export const RUN_DIR = `${APP_DIR}/run`;
export const SOCK_PATH = `${RUN_DIR}/dev-anywhere.sock`;
export const PID_PATH = `${RUN_DIR}/dev-anywhere.pid`;
// 停机标记文件。用户执行 `dev-anywhere stop` 时创建，其它时候不存在。文件内容无意义。
// 作用：告诉 terminal 不要在此期间自动重启 daemon。
//
// 背景：terminal 在与 serve 的连接断开时，默认会 spawn 新 daemon 把连接修复。
// 这与用户执行 stop 的诉求冲突——stop 刚结束 daemon，terminal 会立即把它重新拉起。
// 解决办法是 stop 落下此标记，terminal 重连逻辑先检查标记：存在则仅 tryConnect，不 spawn。
export const STOPPED_PATH = `${RUN_DIR}/stopped`;

// 持久化状态
const STATE_DIR = `${APP_DIR}/state`;
export const SESSIONS_PATH = `${STATE_DIR}/sessions.json`;

// 会话数据
export const DATA_DIR = `${APP_DIR}/data`;

// 日志
export const LOG_DIR = `${APP_DIR}/logs`;
export const SERVICE_LOG_PATH = `${LOG_DIR}/service.log`;

function sessionDir(sessionId: string): string {
  return `${DATA_DIR}/${sessionId}`;
}

export function sessionPaths(sessionId: string) {
  const dir = sessionDir(sessionId);
  return {
    dir,
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
