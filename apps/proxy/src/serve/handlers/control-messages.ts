import { readdir, mkdir } from "node:fs/promises";
import { join, isAbsolute, normalize } from "node:path";
import type { SessionManager } from "../session-manager.js";
import { scanSessionHistory } from "../session-history.js";
import { discoverCommands } from "../command-discovery.js";
import { serviceLogger } from "../../common/logger.js";

export interface ControlMessageHandlers {
  handleDirListRequest(msg: { path: string }): Promise<void>;
  handleDirCreateRequest(msg: { path: string }): Promise<void>;
  handleSessionHistoryRequest(): Promise<void>;
  pushCommandList(sessionId: string, workDir: string): Promise<void>;
  pushFileTree(sessionId: string, workDir: string): Promise<void>;
  reinitializeOnReconnect(): Promise<void>;
  cleanup(sessionId: string): void;
}

// 每个 session 的定时器和资源
interface SessionResources {
  commandRefreshTimer?: NodeJS.Timeout;
  fileTreeWorkDir?: string;
}

// 命令刷新间隔 6 小时
const COMMAND_REFRESH_MS = 6 * 60 * 60 * 1000;

// 路径安全校验：拒绝相对路径和路径遍历
function isPathSafe(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const normalized = normalize(path);
  // 检查 normalize 后是否仍包含 ..（理论上不会，但做防御）
  if (normalized.includes("..")) return false;
  return true;
}

// picker 展示忽略规则: dotfile + node_modules
// listDirectory (按需) 与 getFileTree (预热) 必须共用, 否则逐层下钻会暴露 node_modules
const HIDDEN_ENTRY_NAMES = new Set(["node_modules"]);
function isPickerVisible(name: string): boolean {
  return !name.startsWith(".") && !HIDDEN_ENTRY_NAMES.has(name);
}

// 目录优先 + 字母序, picker 侧依赖这个顺序做键盘导航默认选中
function sortEntries(
  a: { isDir: boolean; name: string },
  b: { isDir: boolean; name: string },
): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

async function scanDir(dirPath: string): Promise<Array<{ name: string; isDir: boolean }>> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => isPickerVisible(e.name))
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    .sort(sortEntries);
}

// 预热 cwd + 直接子目录两层, 按目录分组返回, 前端写入 tree[path] 后逐层 picker 直接命中
interface FileTreeGroup {
  path: string;
  entries: Array<{ name: string; isDir: boolean }>;
}

async function getFileTree(rootPath: string): Promise<FileTreeGroup[]> {
  const groups: FileTreeGroup[] = [];

  let rootEntries: Array<{ name: string; isDir: boolean }>;
  try {
    rootEntries = await scanDir(rootPath);
  } catch {
    return groups;
  }
  groups.push({ path: rootPath, entries: rootEntries });

  for (const sub of rootEntries) {
    if (!sub.isDir) continue;
    const subPath = join(rootPath, sub.name);
    try {
      const subEntries = await scanDir(subPath);
      groups.push({ path: subPath, entries: subEntries });
    } catch {
      // 无法读取子目录, 跳过这一层分组 (picker 会在点击时触发 dir_list_request 补齐)
    }
  }

  return groups;
}

export function createControlMessageHandlers(
  send: (data: string) => void,
  sessionManager: SessionManager,
): ControlMessageHandlers {
  const sessionResources = new Map<string, SessionResources>();

  function getResources(sessionId: string): SessionResources {
    let res = sessionResources.get(sessionId);
    if (!res) {
      res = {};
      sessionResources.set(sessionId, res);
    }
    return res;
  }

  return {
    async handleDirListRequest(msg: { path: string }): Promise<void> {
      // T-06-13: 路径遍历防御
      if (!isPathSafe(msg.path)) {
        send(
          JSON.stringify({
            type: "dir_list_response",
            path: msg.path,
            entries: [],
            error: "Invalid path: must be absolute and must not contain path traversal",
          }),
        );
        serviceLogger.warn({ path: msg.path }, "Rejected dir_list_request: unsafe path");
        return;
      }

      try {
        const entries = await scanDir(msg.path);
        send(
          JSON.stringify({
            type: "dir_list_response",
            path: msg.path,
            entries,
          }),
        );
        serviceLogger.debug({ path: msg.path, count: entries.length }, "Dir list response sent");
      } catch (err) {
        send(
          JSON.stringify({
            type: "dir_list_response",
            path: msg.path,
            entries: [],
            error: String(err),
          }),
        );
        serviceLogger.warn({ path: msg.path, error: String(err) }, "Dir list request failed");
      }
    },

    async handleDirCreateRequest(msg: { path: string }): Promise<void> {
      if (!isPathSafe(msg.path)) {
        send(
          JSON.stringify({
            type: "dir_create_response",
            path: msg.path,
            success: false,
            error: "Invalid path: must be absolute and must not contain path traversal",
          }),
        );
        serviceLogger.warn({ path: msg.path }, "Rejected dir_create_request: unsafe path");
        return;
      }

      try {
        await mkdir(msg.path, { recursive: true });
        send(
          JSON.stringify({
            type: "dir_create_response",
            path: msg.path,
            success: true,
          }),
        );
        serviceLogger.info({ path: msg.path }, "Directory created");
      } catch (err) {
        send(
          JSON.stringify({
            type: "dir_create_response",
            path: msg.path,
            success: false,
            error: String(err),
          }),
        );
        serviceLogger.warn({ path: msg.path, error: String(err) }, "Dir create failed");
      }
    },

    async handleSessionHistoryRequest(): Promise<void> {
      try {
        const sessions = await scanSessionHistory();
        send(
          JSON.stringify({
            type: "session_history_response",
            sessions,
          }),
        );
        serviceLogger.debug({ count: sessions.length }, "Session history response sent");
      } catch (err) {
        send(
          JSON.stringify({
            type: "session_history_response",
            sessions: [],
          }),
        );
        serviceLogger.warn({ error: String(err) }, "Session history scan failed");
      }
    },

    async pushCommandList(sessionId: string, workDir: string): Promise<void> {
      const resources = getResources(sessionId);

      try {
        const commands = await discoverCommands(workDir);
        send(
          JSON.stringify({
            type: "command_list_push",
            commands,
          }),
        );
        serviceLogger.info({ sessionId, count: commands.length, workDir }, "Command list pushed");
      } catch (err) {
        serviceLogger.warn({ sessionId, error: String(err) }, "Command discovery failed");
      }

      // 6 小时定时刷新
      if (resources.commandRefreshTimer) {
        clearInterval(resources.commandRefreshTimer);
      }
      resources.commandRefreshTimer = setInterval(async () => {
        try {
          const commands = await discoverCommands(workDir);
          send(
            JSON.stringify({
              type: "command_list_push",
              commands,
            }),
          );
          serviceLogger.debug({ sessionId, count: commands.length }, "Command list refreshed");
        } catch (err) {
          serviceLogger.warn({ sessionId, error: String(err) }, "Command refresh failed");
        }
      }, COMMAND_REFRESH_MS);
    },

    async pushFileTree(sessionId: string, workDir: string): Promise<void> {
      const resources = getResources(sessionId);
      resources.fileTreeWorkDir = workDir;

      try {
        const groups = await getFileTree(workDir);
        send(
          JSON.stringify({
            type: "file_tree_push",
            groups,
          }),
        );
        serviceLogger.debug(
          { sessionId, path: workDir, groupCount: groups.length },
          "File tree pushed",
        );
      } catch (err) {
        serviceLogger.warn({ sessionId, error: String(err) }, "File tree push failed");
      }
    },

    // relay 重连时同步 session 列表并重新推送控制数据
    async reinitializeOnReconnect(): Promise<void> {
      const activeSessions = sessionManager.listSessions().filter((s) => s.state !== "terminated");

      // 先同步 session 列表，relay 据此建立 proxy-session 关联
      if (activeSessions.length > 0) {
        send(
          JSON.stringify({
            type: "session_sync",
            sessions: activeSessions.map((s) => ({
              id: s.id,
              mode: s.mode,
              state: s.state,
            })),
          }),
        );
        serviceLogger.info({ count: activeSessions.length }, "Session list synced to relay");
      }

      for (const session of activeSessions) {
        const resources = sessionResources.get(session.id);
        const workDir = resources?.fileTreeWorkDir;
        if (workDir) {
          try {
            const commands = await discoverCommands(workDir);
            send(
              JSON.stringify({
                type: "command_list_push",
                commands,
              }),
            );
            const groups = await getFileTree(workDir);
            send(
              JSON.stringify({
                type: "file_tree_push",
                groups,
              }),
            );
            serviceLogger.info(
              { sessionId: session.id },
              "Reinitialized control data after reconnect",
            );
          } catch (err) {
            serviceLogger.warn(
              { sessionId: session.id, error: String(err) },
              "Reinitialize failed",
            );
          }
        }
      }
    },

    cleanup(sessionId: string): void {
      const resources = sessionResources.get(sessionId);
      if (resources) {
        if (resources.commandRefreshTimer) {
          clearInterval(resources.commandRefreshTimer);
        }
        sessionResources.delete(sessionId);
      }
    },
  };
}
