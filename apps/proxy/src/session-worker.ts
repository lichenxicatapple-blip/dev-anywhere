import { createServer, type Socket } from "node:net";
import { mkdirSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import {
  JsonSession,
  ToolWhitelist,
  createPermissionModeApprovalStrategy,
  createRelayApprovalStrategy,
  type StreamJsonEvent,
  type ClaudePermissionMode,
} from "./worker/json-session.js";
import { createApprovalRequestIdFactory } from "./common/approval-request-id.js";
import { SeqCounter } from "./common/seq-counter.js";
import { createWorkerReader, serializeWorkerMsg, type WorkerMessage } from "./ipc/ipc-protocol.js";
import { takeoverServeSocket } from "./worker/serve-socket-takeover.js";
import type { ProviderHookContext } from "./providers/index.js";

// 参数格式: session-worker.ts <sessionId> <socketPath> [--cwd <dir>] [--resume <id>] [-- claude args...]
const sessionId = process.argv[2];
const sockPath = process.argv[3];
const separatorIdx = process.argv.indexOf("--");
const claudeArgs = separatorIdx >= 0 ? process.argv.slice(separatorIdx + 1) : [];

// 解析 -- 之前的可选参数
const preArgs = process.argv.slice(4, separatorIdx >= 0 ? separatorIdx : undefined);
function getArg(name: string): string | undefined {
  const idx = preArgs.indexOf(name);
  return idx >= 0 && idx + 1 < preArgs.length ? preArgs[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return preArgs.includes(name);
}
const workerCwd = getArg("--cwd");
const workerResume = getArg("--resume");
const workerPermissionMode = getArg("--permission-mode") as ClaudePermissionMode | undefined;
const workerStreamDelta = hasFlag("--stream-delta");
const workerHookUrl = getArg("--hook-url");
const workerHookMarker = getArg("--hook-marker");
const workerHookToken = process.env.DEV_ANYWHERE_HOOK_TOKEN;
const workerHookProvider = getArg("--hook-provider") as ProviderHookContext["provider"] | undefined;

if (!sessionId || !sockPath) {
  console.error("Usage: session-worker <sessionId> <socketPath> [-- claudeArgs...]");
  process.exit(1);
}

const workerHook: ProviderHookContext | undefined =
  workerHookUrl && workerHookMarker && workerHookToken && workerHookProvider
    ? {
        provider: workerHookProvider,
        sessionId,
        hookUrl: workerHookUrl,
        marker: workerHookMarker,
        token: workerHookToken,
      }
    : undefined;

let serveSocket: Socket | null = null;
const seqCounter = new SeqCounter(sessionId);
const whitelist = new ToolWhitelist();
const nextApprovalRequestId = createApprovalRequestIdFactory(sessionId);

const pendingApprovals = new Map<
  string,
  {
    resolve: (decision: { behavior: "allow" | "deny"; message?: string }) => void;
    toolName: string;
    input: Record<string, unknown>;
  }
>();

function sendToServe(msg: WorkerMessage): void {
  if (serveSocket?.writable) {
    serveSocket.write(serializeWorkerMsg(msg));
  }
}

// 转发审批请求到 serve 进程，由 serve 进程通过 relay 转发到 web 客户端
const forwardToRelay = async (
  toolName: string,
  input: Record<string, unknown>,
): Promise<{ behavior: "allow" | "deny"; message?: string }> => {
  return new Promise((resolve) => {
    const requestId = nextApprovalRequestId();
    pendingApprovals.set(requestId, { resolve, toolName, input });
    sendToServe({
      type: "worker_approval_request",
      requestId,
      toolName,
      input,
    });
  });
};

const session = new JsonSession({
  claudeArgs,
  cwd: workerCwd,
  resumeSessionId: workerResume,
  permissionMode: workerPermissionMode,
  includePartialMessages: workerStreamDelta,
  hook: workerHook,
  approvalStrategy: createPermissionModeApprovalStrategy(
    workerPermissionMode,
    createRelayApprovalStrategy(whitelist, forwardToRelay),
  ),
  onEvent: (event: StreamJsonEvent) => {
    // 从 system 事件中捕获 Claude 会话 ID 并通知 serve
    if (event.type === "system" && typeof event.session_id === "string") {
      sendToServe({
        type: "worker_claude_session_id",
        sessionId: event.session_id,
      });
    }

    const seq = seqCounter.next();
    sendToServe({
      type: "worker_event",
      seq,
      event: event as Record<string, unknown>,
    });
  },
  onExit: (code: number) => {
    whitelist.clear();
    sendToServe({ type: "worker_exit", code });
    cleanup();
    process.exit(0);
  },
});

function handleServeConnection(socket: Socket): void {
  serveSocket = takeoverServeSocket(serveSocket, socket);

  for (const [requestId, pending] of pendingApprovals) {
    sendToServe({
      type: "worker_approval_request",
      requestId,
      toolName: pending.toolName,
      input: pending.input,
    });
  }

  createWorkerReader(
    socket,
    (msg: WorkerMessage) => {
      switch (msg.type) {
        case "worker_input":
          session.sendMessage(msg.content);
          break;
        case "worker_interrupt":
          rejectAllPendingApprovals("Turn interrupted");
          void session.interruptCurrentTurn().then((interrupted) => {
            if (interrupted) sendToServe({ type: "worker_interrupted" });
            else console.error("[worker] interrupt requested but Claude child was not running");
          });
          break;
        case "worker_stop":
          session.stop();
          break;
        case "worker_approval_response": {
          const pending = pendingApprovals.get(msg.requestId);
          if (pending) {
            pending.resolve({ behavior: msg.behavior, message: msg.message });
            pendingApprovals.delete(msg.requestId);
          }
          break;
        }
        case "worker_whitelist_add":
          whitelist.add(msg.toolName);
          break;
      }
    },
    (err) => {
      // worker 进程没有 pino logger，console.error 经 ipc-protocol 捕获到 stderr。
      // 同样不让单条 schema 错误升级成 socket close。
      console.error(`[worker] serve IPC message dropped: ${err.message}`);
    },
  );

  socket.on("close", () => {
    serveSocket = null;
    rejectAllPendingApprovals("Serve connection closed");
  });
  socket.on("error", () => {
    serveSocket = null;
    rejectAllPendingApprovals("Serve connection error");
  });
}

// serve socket 断开时：所有未决 approval 立即按 deny 落盘。deny 是安全默认值（不执行操作），
// 防止 worker 在 approvalStrategy 里永久 await 一个永不 resolve 的 Promise，从而把 claude
// 进程拖入死锁状态直到 60s reaper。
function rejectAllPendingApprovals(reason: string): void {
  if (pendingApprovals.size === 0) return;
  for (const [, pending] of pendingApprovals) {
    pending.resolve({ behavior: "deny", message: reason });
  }
  pendingApprovals.clear();
}

const sockDir = sockPath.substring(0, sockPath.lastIndexOf("/"));
mkdirSync(sockDir, { recursive: true });

if (existsSync(sockPath)) {
  unlinkSync(sockPath);
}

const server = createServer((socket) => {
  handleServeConnection(socket);
});

function cleanup(): void {
  server.close();
  try {
    unlinkSync(sockPath);
  } catch {
    // socket 文件可能已被删除
  }
}

process.on("SIGTERM", () => {
  session.stop();
});

server.listen(sockPath, () => {
  chmodSync(sockPath, 0o600);
  const pid = session.start();
  sendToServe({ type: "worker_ready", pid });
});
