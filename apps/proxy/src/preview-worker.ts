import { createServer, type Socket } from "node:net";
import { RelayControlSchema } from "@dev-anywhere/shared";
import { flushLogger } from "@dev-anywhere/shared/logger";
import { serviceLogger } from "./common/logger.js";
import { tryAcquireFileLock } from "./common/file-lock.js";
import { tryConnectSocket } from "./common/socket-connect.js";
import {
  prepareLocalIpcEndpoint,
  removeLocalIpcEndpoint,
  setLocalIpcEndpointPermissions,
} from "./common/local-ipc-endpoint.js";
import {
  PREVIEW_WORKER_LOCK,
  PREVIEW_WORKER_SOCK,
  PREVIEWS_PATH,
  PREVIEW_RUN_DIR,
  PROFILE_NAME,
  ensureProfileWorkspace,
} from "./common/paths.js";
import {
  readWorkerConnection,
  takeoverWorkerSocket,
  acceptCurrentWorkerSocketMessage,
  releaseWorkerSocket,
} from "./ipc/worker-connection.js";
import {
  PREVIEW_WORKER_PROTOCOL_VERSION,
  readPreviewWorkerMessages,
  writePreviewWorkerMessage,
  isPreviewControlRequest,
} from "./ipc/preview-worker-protocol.js";
import { cleanupStalePreviewRuntimes } from "./serve/preview/stale-preview-runtime.js";
import { PreviewRuntime } from "./serve/preview/preview-runtime.js";

async function main(): Promise<void> {
  ensureProfileWorkspace();
  // The runtime owns this lock across Serve restarts. Only its owner may clean stale resources.
  const lock = tryAcquireFileLock(PREVIEW_WORKER_LOCK);
  if (!lock) return;
  process.once("exit", () => lock.release());
  const existing = await tryConnectSocket(PREVIEW_WORKER_SOCK);
  if (existing) {
    existing.destroy();
    throw new Error("Another preview worker is using this profile's IPC endpoint");
  }
  prepareLocalIpcEndpoint(PREVIEW_WORKER_SOCK);
  removeLocalIpcEndpoint(PREVIEW_WORKER_SOCK);
  await cleanupStalePreviewRuntimes(PREVIEW_RUN_DIR);

  let current: Socket | null = null;
  let stopping = false;
  let pendingCommands = 0;
  const sockets = new Set<Socket>();
  const sendToSocket = (socket: Socket, raw: string): void => {
    writePreviewWorkerMessage(socket, {
      type: "preview_worker_event",
      message: RelayControlSchema.parse(JSON.parse(raw)),
    });
  };
  const runtime = new PreviewRuntime({
    web: { persistPath: PREVIEWS_PATH, runtimeRoot: PREVIEW_RUN_DIR },
    send: (raw) => {
      if (current?.writable) sendToSocket(current, raw);
    },
  });
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    for (const socket of sockets) socket.destroy();
    await runtime.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    removeLocalIpcEndpoint(PREVIEW_WORKER_SOCK);
    lock.release();
    await flushLogger(serviceLogger);
    process.exit(0);
  };
  const stopIfIdle = (): void => {
    if (!current && pendingCommands === 0 && runtime.empty) void stop();
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    let configured = false;
    const commands = runtime.bindConnection(
      () => current === socket && socket.writable && !socket.destroyed && !stopping,
      (raw) => sendToSocket(socket, raw),
    );
    readWorkerConnection(socket, {
      read: readPreviewWorkerMessages,
      isHello: (message) =>
        message.type === "serve_preview_hello" || message.type === "preview_worker_hello",
      acceptHello: (message) => {
        if (message.type !== "serve_preview_hello") return false;
        if (
          message.profile !== PROFILE_NAME ||
          message.protocolVersion !== PREVIEW_WORKER_PROTOCOL_VERSION
        ) {
          writePreviewWorkerMessage(socket, {
            type: "preview_worker_error",
            error: "Preview worker identity or protocol version does not match Serve",
          });
          return false;
        }
        return true;
      },
      onAccepted: () => {
        if (stopping) {
          socket.destroy();
          return;
        }
        const previous = current;
        current = socket;
        runtime.disconnect();
        takeoverWorkerSocket(previous, socket);
        writePreviewWorkerMessage(socket, {
          type: "preview_worker_hello",
          protocolVersion: PREVIEW_WORKER_PROTOCOL_VERSION,
          profile: PROFILE_NAME,
          pid: process.pid,
        });
      },
      onMessage: (message) => {
        if (!acceptCurrentWorkerSocketMessage(current, socket) || stopping) return;
        if (message.type === "preview_worker_configure") {
          commands.configure(message.relay);
          configured = true;
          return;
        }
        if (
          !configured ||
          message.type !== "preview_worker_request" ||
          !isPreviewControlRequest(message.message)
        ) {
          socket.destroy();
          return;
        }
        pendingCommands += 1;
        void commands
          .handle(message.message)
          .catch((error: unknown) =>
            serviceLogger.error({ error: String(error) }, "Preview command failed"),
          )
          .finally(() => {
            pendingCommands -= 1;
            stopIfIdle();
          });
      },
      onError: (error) =>
        serviceLogger.warn({ error: error.message }, "Preview worker IPC rejected"),
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      sockets.delete(socket);
      const owned = current === socket;
      current = releaseWorkerSocket(current, socket, () => runtime.disconnect());
      if (owned) stopIfIdle();
    });
  });
  server.on("error", (error) => {
    serviceLogger.error({ error: String(error) }, "Preview worker listener failed");
    void stop();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PREVIEW_WORKER_SOCK, () => {
      server.off("error", reject);
      resolve();
    });
  });
  setLocalIpcEndpointPermissions(PREVIEW_WORKER_SOCK);
  // A client can disappear between spawning and attaching; an unused runtime must not linger.
  setTimeout(stopIfIdle, 5_000).unref();
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
  serviceLogger.info({ pid: process.pid, profile: PROFILE_NAME }, "Preview worker ready");
}

void main().catch(async (error: unknown) => {
  serviceLogger.error({ error: String(error) }, "Preview worker startup failed");
  await flushLogger(serviceLogger);
  process.exit(1);
});
