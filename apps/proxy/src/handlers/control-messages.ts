import { readdir } from "node:fs/promises";
import { join, isAbsolute, normalize } from "node:path";
import type { Logger } from "pino";
import type { SessionManager } from "../session-manager.js";
import type { TerminalTracker } from "../terminal-tracker.js";
import { scanSessionHistory } from "../session-history.js";

export interface ControlMessageHandlers {
  handleDirListRequest(msg: { path: string }): Promise<void>;
  handleSessionHistoryRequest(): Promise<void>;
  handleTerminalLinesRequest(msg: { sessionId: string; fromLineId: number; count: number }): void;
  registerTracker(sessionId: string, tracker: TerminalTracker): void;
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

// 列出目录内容
async function listDirectory(dirPath: string): Promise<Array<{ name: string; isDir: boolean }>> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => !e.name.startsWith("."))
    .map((e) => ({
      name: e.name,
      isDir: e.isDirectory(),
    }))
    .sort((a, b) => {
      // 目录排前面
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

// 获取 2 层深度的文件树
async function getFileTree(rootPath: string): Promise<Array<{ name: string; isDir: boolean }>> {
  const result: Array<{ name: string; isDir: boolean }> = [];

  try {
    const level1 = await readdir(rootPath, { withFileTypes: true });
    for (const entry of level1) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      result.push({ name: entry.name, isDir: entry.isDirectory() });

      if (entry.isDirectory()) {
        try {
          const level2 = await readdir(join(rootPath, entry.name), { withFileTypes: true });
          for (const sub of level2) {
            if (sub.name.startsWith(".")) continue;
            result.push({ name: `${entry.name}/${sub.name}`, isDir: sub.isDirectory() });
          }
        } catch {
          // 无法读取子目录，跳过
        }
      }
    }
  } catch {
    // 无法读取根目录
  }

  return result;
}

// 发现可用 slash 命令
// 当前使用静态列表，后续 Plan 会实现动态发现
async function discoverCommands(_workDir: string): Promise<Array<{
  name: string;
  description: string;
  argumentHint?: string;
  source: string;
}>> {
  return [
    { name: "/help", description: "Show help information", source: "builtin" },
    { name: "/clear", description: "Clear conversation history", source: "builtin" },
    { name: "/compact", description: "Compact conversation to reduce context", source: "builtin" },
    { name: "/config", description: "Show or modify configuration", argumentHint: "[key] [value]", source: "builtin" },
  ];
}

export function createControlMessageHandlers(
  send: (data: string) => void,
  sessionManager: SessionManager,
  logger: Logger,
): ControlMessageHandlers {
  const sessionResources = new Map<string, SessionResources>();
  const trackers = new Map<string, TerminalTracker>();

  function getResources(sessionId: string): SessionResources {
    let res = sessionResources.get(sessionId);
    if (!res) {
      res = {};
      sessionResources.set(sessionId, res);
    }
    return res;
  }

  return {
    registerTracker(sessionId: string, tracker: TerminalTracker): void {
      trackers.set(sessionId, tracker);
    },

    handleTerminalLinesRequest(msg: { sessionId: string; fromLineId: number; count: number }): void {
      const tracker = trackers.get(msg.sessionId);
      if (!tracker) {
        logger.warn({ sessionId: msg.sessionId }, "terminal_lines_request: no tracker for session");
        send(JSON.stringify({
          type: "relay_error",
          code: "SESSION_NOT_FOUND",
          message: `No terminal tracker for session ${msg.sessionId}`,
        }));
        return;
      }

      const lines = tracker.extractLines(msg.fromLineId, msg.count);
      send(JSON.stringify({
        type: "terminal_lines_response",
        sessionId: msg.sessionId,
        fromLineId: msg.fromLineId,
        oldestLineId: tracker.getOldestLineId(),
        newestLineId: tracker.getNewestLineId(),
        lines,
      }));
      logger.debug({ sessionId: msg.sessionId, fromLineId: msg.fromLineId, count: msg.count, returned: lines.length }, "Terminal lines response sent");
    },

    async handleDirListRequest(msg: { path: string }): Promise<void> {
      // T-06-13: 路径遍历防御
      if (!isPathSafe(msg.path)) {
        send(JSON.stringify({
          type: "dir_list_response",
          path: msg.path,
          entries: [],
          error: "Invalid path: must be absolute and must not contain path traversal",
        }));
        logger.warn({ path: msg.path }, "Rejected dir_list_request: unsafe path");
        return;
      }

      try {
        const entries = await listDirectory(msg.path);
        send(JSON.stringify({
          type: "dir_list_response",
          path: msg.path,
          entries,
        }));
        logger.debug({ path: msg.path, count: entries.length }, "Dir list response sent");
      } catch (err) {
        send(JSON.stringify({
          type: "dir_list_response",
          path: msg.path,
          entries: [],
          error: String(err),
        }));
        logger.warn({ path: msg.path, error: String(err) }, "Dir list request failed");
      }
    },

    async handleSessionHistoryRequest(): Promise<void> {
      try {
        const sessions = await scanSessionHistory();
        send(JSON.stringify({
          type: "session_history_response",
          sessions,
        }));
        logger.debug({ count: sessions.length }, "Session history response sent");
      } catch (err) {
        send(JSON.stringify({
          type: "session_history_response",
          sessions: [],
        }));
        logger.warn({ error: String(err) }, "Session history scan failed");
      }
    },

    async pushCommandList(sessionId: string, workDir: string): Promise<void> {
      const resources = getResources(sessionId);

      try {
        const commands = await discoverCommands(workDir);
        send(JSON.stringify({
          type: "command_list_push",
          commands,
        }));
        logger.debug({ sessionId, count: commands.length }, "Command list pushed");
      } catch (err) {
        logger.warn({ sessionId, error: String(err) }, "Command discovery failed");
      }

      // 6 小时定时刷新
      if (resources.commandRefreshTimer) {
        clearInterval(resources.commandRefreshTimer);
      }
      resources.commandRefreshTimer = setInterval(async () => {
        try {
          const commands = await discoverCommands(workDir);
          send(JSON.stringify({
            type: "command_list_push",
            commands,
          }));
          logger.debug({ sessionId, count: commands.length }, "Command list refreshed");
        } catch (err) {
          logger.warn({ sessionId, error: String(err) }, "Command refresh failed");
        }
      }, COMMAND_REFRESH_MS);
    },

    async pushFileTree(sessionId: string, workDir: string): Promise<void> {
      const resources = getResources(sessionId);
      resources.fileTreeWorkDir = workDir;

      try {
        const entries = await getFileTree(workDir);
        send(JSON.stringify({
          type: "file_tree_push",
          path: workDir,
          entries,
        }));
        logger.debug({ sessionId, path: workDir, count: entries.length }, "File tree pushed");
      } catch (err) {
        logger.warn({ sessionId, error: String(err) }, "File tree push failed");
      }
    },

    // relay 重连时重新推送所有活跃 session 的 command list 和 file tree
    async reinitializeOnReconnect(): Promise<void> {
      const activeSessions = sessionManager.listSessions()
        .filter((s) => s.state !== "terminated");

      for (const session of activeSessions) {
        const resources = sessionResources.get(session.id);
        const workDir = resources?.fileTreeWorkDir;
        if (workDir) {
          try {
            const commands = await discoverCommands(workDir);
            send(JSON.stringify({
              type: "command_list_push",
              commands,
            }));
            const entries = await getFileTree(workDir);
            send(JSON.stringify({
              type: "file_tree_push",
              path: workDir,
              entries,
            }));
            logger.info({ sessionId: session.id }, "Reinitialized control data after reconnect");
          } catch (err) {
            logger.warn({ sessionId: session.id, error: String(err) }, "Reinitialize failed");
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
      trackers.delete(sessionId);
    },
  };
}
