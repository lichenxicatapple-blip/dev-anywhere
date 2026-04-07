import { createServer, type Socket } from "node:net";
import { mkdirSync, unlinkSync, existsSync, chmodSync } from "node:fs";
import { JsonSession, type StreamJsonEvent } from "./json-session.js";
import { EventStore, EventType } from "./event-store.js";
import {
  createWorkerReader,
  serializeWorkerMsg,
  type WorkerMessage,
} from "./ipc-protocol.js";

// 参数格式: session-worker.ts <sessionId> <socketPath> [-- claude args...]
const sessionId = process.argv[2];
const sockPath = process.argv[3];
const separatorIdx = process.argv.indexOf("--");
const claudeArgs = separatorIdx >= 0 ? process.argv.slice(separatorIdx + 1) : [];

if (!sessionId || !sockPath) {
  console.error("Usage: session-worker <sessionId> <socketPath> [-- claudeArgs...]");
  process.exit(1);
}

let serveSocket: Socket | null = null;
const eventStore = new EventStore(sessionId);

const pendingApprovals = new Map<
  string,
  { resolve: (decision: { behavior: "allow" | "deny"; message?: string }) => void }
>();

function sendToServe(msg: WorkerMessage): void {
  if (serveSocket?.writable) {
    serveSocket.write(serializeWorkerMsg(msg));
  }
}

const session = new JsonSession({
  claudeArgs,
  approvalStrategy: async (toolName, input) => {
    return new Promise((resolve) => {
      const requestId = `${sessionId}-${Date.now()}`;
      pendingApprovals.set(requestId, { resolve });
      sendToServe({
        type: "worker_approval_request",
        requestId,
        toolName,
        input,
      });
    });
  },
  onEvent: (event: StreamJsonEvent) => {
    // 写入 EventStore 获取 per-session seq，带给 serve 构建 MessageEnvelope
    const seq = eventStore.writeImmediate(
      EventType.PTY_OUTPUT,
      Buffer.from(JSON.stringify(event), "utf-8"),
    );
    sendToServe({
      type: "worker_event",
      seq,
      event: event as Record<string, unknown>,
    });
  },
  onExit: (code: number) => {
    eventStore.close();
    sendToServe({ type: "worker_exit", code });
    cleanup();
    process.exit(0);
  },
});

function handleServeConnection(socket: Socket): void {
  serveSocket = socket;

  for (const [requestId] of pendingApprovals) {
    sendToServe({
      type: "worker_approval_request",
      requestId,
      toolName: "pending-resend",
      input: {},
    });
  }

  createWorkerReader(socket, (msg: WorkerMessage) => {
    switch (msg.type) {
      case "worker_input":
        session.sendMessage(msg.content);
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
    }
  });

  socket.on("close", () => { serveSocket = null; });
  socket.on("error", () => { serveSocket = null; });
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
  try { unlinkSync(sockPath); } catch {}
}

process.on("SIGTERM", () => {
  session.stop();
});

server.listen(sockPath, () => {
  chmodSync(sockPath, 0o600);
  const pid = session.start();
  sendToServe({ type: "worker_ready", pid });
});
