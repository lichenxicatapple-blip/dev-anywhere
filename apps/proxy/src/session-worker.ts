import { createServer, type Socket } from "node:net";
import { mkdirSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import {
  JsonSession,
  ToolWhitelist,
  createRelayApprovalStrategy,
  type ClaudePermissionMode,
} from "./worker/json-session.js";
import { CodexAppServerSession } from "./worker/codex-app-server-session.js";
import {
  KimiAcpSession,
  type KimiAcpPermissionDecision,
  type KimiAcpPermissionOption,
} from "./worker/kimi-acp-session.js";
import { createApprovalRequestIdFactory } from "./common/approval-request-id.js";
import { SeqCounter } from "./common/seq-counter.js";
import {
  WORKER_IPC_PROTOCOL_VERSION,
  createWorkerReader,
  serializeWorkerMsg,
  type WorkerMessage,
} from "./ipc/ipc-protocol.js";
import {
  acceptCurrentServeSocketMessage,
  releaseServeSocket,
  takeoverServeSocket,
} from "./worker/serve-socket-takeover.js";
import type { ProviderHookContext, ProviderId } from "./providers/index.js";
import { ControlErrorCode } from "@dev-anywhere/shared";
import {
  classifyCodexActiveWriterError,
  sanitizeProviderErrorTail,
} from "./common/codex-session-conflict.js";

// 参数格式: session-worker.ts <sessionId> <socketPath> [--provider <provider>] [--cwd <dir>] [--resume <id>] [-- provider args...]
const sessionId = process.argv[2];
const sockPath = process.argv[3];
const separatorIdx = process.argv.indexOf("--");
const providerArgs = separatorIdx >= 0 ? process.argv.slice(separatorIdx + 1) : [];

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
const providerArg = getArg("--provider");

if (!sessionId || !sockPath) {
  console.error("Usage: session-worker <sessionId> <socketPath> [-- claudeArgs...]");
  process.exit(1);
}

if (providerArg !== "claude" && providerArg !== "codex" && providerArg !== "kimi") {
  console.error(
    providerArg === undefined
      ? "JSON worker provider is required"
      : `Unsupported JSON worker provider: ${providerArg}`,
  );
  process.exit(1);
}
const provider = providerArg as ProviderId;

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
let negotiatedServeSocket: Socket | null = null;
const queuedServeMessages: WorkerMessage[] = [];
let latestKimiCommandEvent: Extract<WorkerMessage, { type: "worker_event" }> | null = null;
let readyMessage: Extract<WorkerMessage, { type: "worker_ready" }> | null = null;
let providerReady = false;
let exiting = false;
let kimiTurnActive = false;
const seqCounter = new SeqCounter(sessionId);
const whitelist = new ToolWhitelist();
const nextApprovalRequestId = createApprovalRequestIdFactory(sessionId);

const pendingApprovals = new Map<
  string,
  {
    resolve: (decision: WorkerApprovalDecision) => void;
    toolName: string;
    input: Record<string, unknown>;
    options?: WorkerApprovalOption[];
  }
>();

type WorkerApprovalOption = NonNullable<
  Extract<WorkerMessage, { type: "worker_approval_request" }>["options"]
>[number];

interface WorkerApprovalDecision {
  behavior: "allow" | "deny";
  message?: string;
  remember?: boolean;
  optionId?: string;
  cancelled?: boolean;
}

function isKimiCommandEvent(
  msg: WorkerMessage,
): msg is Extract<WorkerMessage, { type: "worker_event" }> {
  if (msg.type !== "worker_event" || msg.event.type !== "kimi_acp") return false;
  const params = msg.event.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return false;
  const update = (params as Record<string, unknown>).update;
  return Boolean(
    update &&
    typeof update === "object" &&
    !Array.isArray(update) &&
    (update as Record<string, unknown>).sessionUpdate === "available_commands_update",
  );
}

function sendToServe(msg: WorkerMessage): void {
  if (isKimiCommandEvent(msg)) latestKimiCommandEvent = msg;
  if (!providerReady && msg.type !== "worker_startup_error" && msg.type !== "worker_exit") {
    if (!isKimiCommandEvent(msg) && msg.type !== "worker_approval_request") {
      queuedServeMessages.push(msg);
    }
    return;
  }
  if (serveSocket?.writable && negotiatedServeSocket === serveSocket) {
    serveSocket.write(serializeWorkerMsg(msg));
    return;
  }
  if (isKimiCommandEvent(msg)) return;
  if (msg.type !== "worker_approval_request") {
    queuedServeMessages.push(msg);
  }
}

function flushQueuedServeMessages(): void {
  if (!serveSocket?.writable || negotiatedServeSocket !== serveSocket) return;
  while (queuedServeMessages.length > 0) {
    const msg = queuedServeMessages.shift();
    if (msg) serveSocket.write(serializeWorkerMsg(msg));
  }
}

function reportReady(message: Extract<WorkerMessage, { type: "worker_ready" }>): void {
  readyMessage = message;
  providerReady = true;
  replayServeState(serveSocket);
}

function replayServeState(socket: Socket | null): void {
  if (!socket?.writable || serveSocket !== socket || negotiatedServeSocket !== socket) return;
  if (!providerReady || !readyMessage) return;

  socket.write(serializeWorkerMsg(readyMessage));
  const queuedKimiTurnStart = queuedServeMessages.some(
    (message) => message.type === "worker_turn_started",
  );
  // If start happened on the previous connection, restore WORKING before replaying chunks. When
  // start itself is queued, preserve backlog order (previous result -> next start -> next chunks).
  if (provider === "kimi" && kimiTurnActive && !queuedKimiTurnStart) {
    socket.write(serializeWorkerMsg({ type: "worker_turn_started" }));
  }
  flushQueuedServeMessages();
  if (latestKimiCommandEvent && socket.writable) {
    socket.write(serializeWorkerMsg(latestKimiCommandEvent));
  }

  for (const [requestId, pending] of pendingApprovals) {
    socket.write(
      serializeWorkerMsg({
        type: "worker_approval_request",
        requestId,
        toolName: pending.toolName,
        input: pending.input,
        ...(pending.options ? { options: pending.options } : {}),
      }),
    );
  }
}

// 转发审批请求到 serve 进程，由 serve 进程通过 relay 转发到 web 客户端
const forwardToRelay = async (
  toolName: string,
  input: Record<string, unknown>,
  options?: WorkerApprovalOption[],
): Promise<WorkerApprovalDecision> => {
  return new Promise((resolve) => {
    const requestId = nextApprovalRequestId();
    pendingApprovals.set(requestId, { resolve, toolName, input, options });
    sendToServe({
      type: "worker_approval_request",
      requestId,
      toolName,
      input,
      ...(options ? { options } : {}),
    });
  });
};

// Claude/Codex own the permission-mode semantics. This strategy only resolves
// approval requests that the provider actually chose to surface.
const approvalStrategy = createRelayApprovalStrategy(whitelist, forwardToRelay);

function handleProviderEvent(event: Record<string, unknown>): void {
  // 从 system 事件中捕获 Claude 会话 ID 并通知 serve
  if (event.type === "system" && typeof event.session_id === "string") {
    sendToServe({
      type: "worker_native_session_id",
      provider: "claude",
      sessionId: event.session_id,
    });
  }

  const seq = seqCounter.next();
  sendToServe({
    type: "worker_event",
    seq,
    event: event as Record<string, unknown>,
  });
}

function handleKimiEvent(
  method: "session/update" | "session/prompt/result" | "session/prompt/error",
  params: Record<string, unknown>,
): void {
  handleProviderEvent({ type: "kimi_acp", method, params });
}

function workerApprovalOptions(options: KimiAcpPermissionOption[]): WorkerApprovalOption[] {
  return options.flatMap((option) => {
    if (
      option.kind !== "allow_once" &&
      option.kind !== "allow_always" &&
      option.kind !== "reject_once" &&
      option.kind !== "reject_always"
    ) {
      return [];
    }
    return [{ optionId: option.optionId, name: option.name, kind: option.kind }];
  });
}

async function handleKimiPermissionRequest(request: {
  toolName: string;
  input: Record<string, unknown>;
  options: KimiAcpPermissionOption[];
}): Promise<KimiAcpPermissionDecision> {
  if (whitelist.has(request.toolName)) return { behavior: "allow_always" };
  const options = workerApprovalOptions(request.options);
  const decision = await forwardToRelay(
    request.toolName,
    request.input,
    options.length > 0 ? options : undefined,
  );
  if (decision.cancelled) return { cancelled: true };
  return {
    behavior:
      decision.behavior === "deny" ? "deny" : decision.remember ? "allow_always" : "allow_once",
    ...(decision.message ? { message: decision.message } : {}),
    ...(decision.optionId ? { optionId: decision.optionId } : {}),
  };
}

function handleProviderExit(code: number): void {
  if (exiting) return;
  exiting = true;
  kimiTurnActive = false;
  whitelist.clear();
  const errorTail = code === 0 ? "" : sanitizeProviderErrorTail(session.getStderr());
  sendToServe({
    type: "worker_exit",
    code,
    ...(errorTail ? { errorTail } : {}),
  });
  cleanup();
  process.exit(0);
}

const session =
  provider === "codex"
    ? new CodexAppServerSession({
        cwd: workerCwd,
        resumeSessionId: workerResume,
        permissionMode: workerPermissionMode,
        approvalStrategy,
        onEvent: handleProviderEvent,
        onThreadId: (threadId) => {
          sendToServe({
            type: "worker_native_session_id",
            provider: "codex",
            sessionId: threadId,
          });
        },
        onExit: handleProviderExit,
      })
    : provider === "kimi"
      ? new KimiAcpSession({
          cwd: workerCwd,
          resumeSessionId: workerResume,
          permissionMode: workerPermissionMode,
          onUpdate: (params) => handleKimiEvent("session/update", params),
          onPermissionRequest: handleKimiPermissionRequest,
          onPromptStart: () => {
            kimiTurnActive = true;
            sendToServe({ type: "worker_turn_started" });
          },
          onPromptComplete: (result) => {
            kimiTurnActive = false;
            handleKimiEvent("session/prompt/result", { response: result });
          },
          onPromptError: (error) => {
            kimiTurnActive = false;
            handleKimiEvent("session/prompt/error", {
              message: sanitizeProviderErrorTail(error.message) || "Kimi ACP prompt failed",
            });
          },
          onSessionId: (kimiSessionId) => {
            sendToServe({
              type: "worker_native_session_id",
              provider: "kimi",
              sessionId: kimiSessionId,
            });
          },
          onProtocolError: (error) => console.error(`[worker] ${error.message}`),
          onProcessError: (error) => console.error(`[worker] ${error.message}`),
          onExit: handleProviderExit,
        })
      : new JsonSession({
          claudeArgs: providerArgs,
          cwd: workerCwd,
          resumeSessionId: workerResume,
          permissionMode: workerPermissionMode,
          includePartialMessages: workerStreamDelta,
          hook: workerHook,
          approvalStrategy,
          onEvent: handleProviderEvent,
          onExit: handleProviderExit,
        });

function handleServeConnection(socket: Socket): void {
  const previousServeSocket = serveSocket;
  serveSocket = socket;
  negotiatedServeSocket = null;
  takeoverServeSocket(previousServeSocket, socket);
  // Every daemon connection begins with an independent protocol handshake. Provider readiness
  // follows separately, so bootstrap failures can still be delivered on a negotiated connection.
  serveSocket.write(
    serializeWorkerMsg({
      type: "worker_protocol_hello",
      protocolVersion: WORKER_IPC_PROTOCOL_VERSION,
      sessionId,
      provider,
      pid: process.pid,
    }),
  );
  let protocolAccepted = false;
  createWorkerReader(
    socket,
    (msg: WorkerMessage) => {
      if (!acceptCurrentServeSocketMessage(serveSocket, socket)) return;
      if (!protocolAccepted) {
        if (msg.type !== "serve_protocol_hello" || msg.sessionId !== sessionId) {
          console.error("[worker] serve IPC protocol handshake rejected");
          socket.destroy();
          return;
        }
        protocolAccepted = true;
        negotiatedServeSocket = socket;
        replayServeState(socket);
        return;
      }
      if (msg.type === "serve_protocol_hello") {
        console.error("[worker] duplicate serve IPC protocol hello");
        socket.destroy();
        return;
      }
      if (!providerReady && msg.type !== "worker_stop") {
        console.error(`[worker] serve message ${msg.type} arrived before provider readiness`);
        socket.destroy();
        return;
      }
      switch (msg.type) {
        case "worker_input":
          session.sendMessage(msg.content);
          break;
        case "worker_interrupt":
          if (provider === "kimi") {
            void session.interruptCurrentTurn().then((interrupted) => {
              if (interrupted) {
                kimiTurnActive = false;
                rejectAllPendingApprovals("Turn interrupted", true);
                sendToServe({ type: "worker_interrupted" });
              } else {
                console.error("[worker] interrupt requested but Kimi had no active turn");
              }
            });
          } else {
            rejectAllPendingApprovals("Turn interrupted");
            void session.interruptCurrentTurn().then((interrupted) => {
              if (interrupted) sendToServe({ type: "worker_interrupted" });
              else console.error("[worker] interrupt requested but provider child was not running");
            });
          }
          break;
        case "worker_stop":
          session.stop();
          break;
        case "worker_approval_response": {
          const pending = pendingApprovals.get(msg.requestId);
          if (pending) {
            pending.resolve({
              behavior: msg.behavior,
              ...(msg.message ? { message: msg.message } : {}),
              ...(msg.remember ? { remember: true } : {}),
              ...(msg.optionId ? { optionId: msg.optionId } : {}),
            });
            pendingApprovals.delete(msg.requestId);
          }
          break;
        }
        case "worker_whitelist_add":
          whitelist.add(msg.toolName);
          break;
        default:
          console.error(`[worker] invalid serve-to-worker message type: ${msg.type}`);
          socket.destroy();
      }
    },
    (err) => {
      if (!protocolAccepted) {
        console.error(`[worker] serve IPC protocol handshake rejected: ${err.message}`);
        socket.destroy();
        return;
      }
      // worker 进程没有 pino logger，console.error 经 ipc-protocol 捕获到 stderr。
      // 同样不让单条 schema 错误升级成 socket close。
      console.error(`[worker] serve IPC message dropped: ${err.message}`);
    },
  );

  socket.on("close", () => {
    serveSocket = releaseServeSocket(serveSocket, socket, () => {
      negotiatedServeSocket = null;
      rejectAllPendingApprovals("Serve connection closed");
    });
  });
  socket.on("error", () => {
    serveSocket = releaseServeSocket(serveSocket, socket, () => {
      negotiatedServeSocket = null;
      rejectAllPendingApprovals("Serve connection error");
    });
  });
}

// serve socket 断开时：所有未决 approval 立即按 deny 落盘。deny 是安全默认值（不执行操作），
// 防止 worker 在 approvalStrategy 里永久 await 一个永不 resolve 的 Promise，从而把 claude
// 进程拖入死锁状态直到 60s reaper。
function rejectAllPendingApprovals(reason: string, cancelled = false): void {
  if (pendingApprovals.size === 0) return;
  for (const [, pending] of pendingApprovals) {
    pending.resolve({
      behavior: "deny",
      message: reason,
      ...(cancelled ? { cancelled: true } : {}),
    });
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
  if (!Number.isFinite(pid) || pid <= 0) {
    console.error("[worker] provider process failed to start: missing child pid");
    handleProviderExit(1);
    return;
  }
  if (provider === "codex" && session instanceof CodexAppServerSession) {
    void session
      .waitUntilReady()
      .then((threadId) => {
        reportReady({
          type: "worker_ready",
          pid,
          nativeSession: { provider: "codex", sessionId: threadId },
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const failureOutput = `${message}\n${session.getStderr()}`;
        const diagnostic =
          sanitizeProviderErrorTail(failureOutput) || "Codex app-server 初始化失败";
        const activeWriter = classifyCodexActiveWriterError(failureOutput);
        sendToServe({
          type: "worker_startup_error",
          provider: "codex",
          message: diagnostic,
          ...(activeWriter
            ? {
                errorCode: ControlErrorCode.SESSION_ALREADY_ACTIVE,
                nativeSessionId: activeWriter.threadId,
              }
            : {}),
        });
        console.error(`[worker] Codex app-server failed to initialize: ${diagnostic}`);
        void session.stop(0).finally(() => handleProviderExit(1));
      });
  } else if (provider === "kimi" && session instanceof KimiAcpSession) {
    void session
      .waitUntilReady()
      .then((kimiSessionId) => {
        reportReady({
          type: "worker_ready",
          pid,
          nativeSession: { provider: "kimi", sessionId: kimiSessionId },
        });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const diagnostic =
          sanitizeProviderErrorTail(`${message}\n${session.getStderr()}`) || "Kimi ACP 初始化失败";
        sendToServe({
          type: "worker_startup_error",
          provider: "kimi",
          message: diagnostic,
        });
        console.error(`[worker] Kimi ACP failed to initialize: ${diagnostic}`);
        void session.stop(0).finally(() => handleProviderExit(1));
      });
  } else {
    reportReady({ type: "worker_ready", pid });
  }
});
