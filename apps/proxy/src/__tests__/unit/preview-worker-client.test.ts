import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewSummary } from "@dev-anywhere/shared";
import { localIpcEndpointPath } from "#src/common/paths.js";
import {
  acceptCurrentWorkerSocketMessage,
  readWorkerConnection,
  releaseWorkerSocket,
  takeoverWorkerSocket,
} from "#src/ipc/worker-connection.js";
import {
  PREVIEW_WORKER_PROTOCOL_VERSION,
  readPreviewWorkerMessages,
  writePreviewWorkerMessage,
  type PreviewWorkerMessage,
} from "#src/ipc/preview-worker-protocol.js";
import { PreviewWorkerClient } from "#src/serve/preview/preview-worker-client.js";

const PROFILE = "preview-worker-client-test";
const RELAY = { relayUrl: "ws://relay.invalid", proxyId: "test-proxy", token: "test-token" };
const SCOPE = { proxyId: RELAY.proxyId, bindingId: "binding-1" };
const HELLO = {
  type: "preview_worker_hello" as const,
  protocolVersion: PREVIEW_WORKER_PROTOCOL_VERSION,
  profile: PROFILE,
  pid: 4242,
};

const clients: PreviewWorkerClient[] = [];
const sockets = new Set<Socket>();
const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function endpoint(): Promise<string> {
  // Keep Unix sockets below sockaddr_un's limit on macOS; Windows uses a named pipe.
  const directory = await mkdtemp(
    join(process.platform === "win32" ? tmpdir() : "/tmp", "da-pwc-"),
  );
  directories.push(directory);
  return localIpcEndpointPath(join(directory, "preview-worker.sock"));
}

function track(socket: Socket): Socket {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => sockets.delete(socket));
  return socket;
}

async function listen(path: string, onConnection: (socket: Socket) => void): Promise<Server> {
  const server = createServer((socket) => onConnection(track(socket)));
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function client(path: string, options: { profile?: string; startupTimeoutMs?: number } = {}) {
  const send = vi.fn();
  const spawn = vi.fn();
  const attachment = new PreviewWorkerClient({
    relay: RELAY,
    socketPath: path,
    profile: PROFILE,
    send,
    spawn,
    startupTimeoutMs: 250,
    ...options,
  });
  clients.push(attachment);
  return { attachment, send, spawn };
}

function list(attachment: PreviewWorkerClient, requestId: string) {
  return attachment.handle({ type: "preview_list_request", requestId, scope: SCOPE });
}

function response(send: ReturnType<typeof vi.fn>, requestId: string) {
  return send.mock.calls
    .map(([raw]) => JSON.parse(raw as string) as Record<string, unknown>)
    .find((message) => message.requestId === requestId);
}

async function worker(
  path: string,
  options: { automaticHello?: boolean; timeoutMs?: number } = {},
) {
  let current: Socket | null = null;
  const connections: Socket[] = [];
  const accepted: Socket[] = [];
  const received: Array<{ socket: Socket; message: PreviewWorkerMessage }> = [];
  const errors: Error[] = [];
  const disconnect = vi.fn();
  const snapshot: { epoch: string; revision: number; previews: PreviewSummary[] } = {
    epoch: "retained-worker-epoch",
    revision: 3,
    previews: [
      {
        previewId: "retained-web",
        name: "Retained name",
        state: "ready",
        source: { kind: "local", url: "http://127.0.0.1:3000" },
        tunnelProvider: "cloudflare",
        publicUrl: "https://retained-runtime-42.trycloudflare.com",
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  };
  const hello = (socket: Socket) => writePreviewWorkerMessage(socket, HELLO);
  const server = await listen(path, (socket) => {
    connections.push(socket);
    let configured = false;
    readWorkerConnection<PreviewWorkerMessage>(socket, {
      read: (peer, onMessage, onError) =>
        readPreviewWorkerMessages(
          peer,
          (message) => {
            received.push({ socket, message });
            onMessage(message);
          },
          onError,
        ),
      isHello: (message) =>
        message.type === "serve_preview_hello" || message.type === "preview_worker_hello",
      acceptHello: (message) => {
        if (message.type !== "serve_preview_hello") return false;
        if (
          message.profile !== PROFILE ||
          message.protocolVersion !== PREVIEW_WORKER_PROTOCOL_VERSION
        ) {
          writePreviewWorkerMessage(socket, {
            type: "preview_worker_error",
            error: "Incompatible preview worker identity",
          });
          return false;
        }
        return true;
      },
      onAccepted: () => {
        accepted.push(socket);
        current = takeoverWorkerSocket(current, socket);
        if (options.automaticHello !== false) hello(socket);
      },
      onMessage: (message) => {
        if (!acceptCurrentWorkerSocketMessage(current, socket)) return;
        if (message.type === "preview_worker_configure") {
          configured = true;
          return;
        }
        if (!configured || message.type !== "preview_worker_request") {
          socket.destroy();
          return;
        }
        if (message.message.type === "preview_list_request") {
          writePreviewWorkerMessage(socket, {
            type: "preview_worker_event",
            message: {
              type: "preview_list_response",
              requestId: message.message.requestId,
              scope: message.message.scope,
              ...snapshot,
            },
          });
        }
      },
      onError: (error) => errors.push(error),
      timeoutMs: options.timeoutMs,
    });
    socket.once("close", () => {
      current = releaseWorkerSocket(current, socket, disconnect);
    });
  });
  return {
    server,
    connections,
    accepted,
    received,
    errors,
    disconnect,
    snapshot,
    hello,
    current: () => current,
  };
}

describe("PreviewWorkerClient real local IPC", () => {
  it("admits hello before configure/request, single-flights callers and forwards worker events", async () => {
    const path = await endpoint();
    const host = await worker(path, { automaticHello: false });
    const { attachment, send, spawn } = client(path);
    attachment.register("serve-before-hello");
    attachment.start();
    const pending = list(attachment, "first-list");
    await vi.waitFor(() => expect(host.accepted).toHaveLength(1));
    expect(host.received.map(({ message }) => message.type)).toEqual(["serve_preview_hello"]);
    expect(send).not.toHaveBeenCalled();
    host.hello(host.accepted[0]!);
    await pending;
    expect(host.errors).toEqual([]);
    await vi.waitFor(() => expect(response(send, "first-list")).toBeDefined());
    expect(host.received.map(({ message }) => message.type)).toEqual([
      "serve_preview_hello",
      "preview_worker_configure",
      "preview_worker_request",
    ]);
    expect(host.received[1]?.message).toEqual({
      type: "preview_worker_configure",
      relay: { ...RELAY, connectionId: "serve-before-hello" },
    });
    expect(response(send, "first-list")).toEqual({
      type: "preview_list_response",
      requestId: "first-list",
      scope: SCOPE,
      ...host.snapshot,
    });
    attachment.disconnectRelay();
    await vi.waitFor(() =>
      expect(host.received.at(-1)?.message).toEqual({
        type: "preview_worker_configure",
        relay: { ...RELAY, connectionId: null },
      }),
    );
    expect(host.current()).not.toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("drops a request waiting for hello when the Relay attachment generation changes", async () => {
    const path = await endpoint();
    const host = await worker(path, { automaticHello: false });
    const { attachment, send, spawn } = client(path);
    attachment.register("serve-old");
    const staleRequest = list(attachment, "old-generation-list");
    await vi.waitFor(() => expect(host.accepted).toHaveLength(1));

    attachment.disconnectRelay();
    attachment.register("serve-new");
    host.hello(host.accepted[0]!);
    await staleRequest;
    await vi.waitFor(() =>
      expect(host.received.at(-1)?.message).toEqual({
        type: "preview_worker_configure",
        relay: { ...RELAY, connectionId: "serve-new" },
      }),
    );

    const newScope = { ...SCOPE, bindingId: "binding-2" };
    await attachment.handle({
      type: "preview_list_request",
      requestId: "new-generation-list",
      scope: newScope,
    });
    await vi.waitFor(() =>
      expect(response(send, "new-generation-list")).toMatchObject({
        scope: newScope,
        ...host.snapshot,
      }),
    );
    expect(
      host.received
        .filter(({ message }) => message.type === "preview_worker_request")
        .map(({ message }) =>
          message.type === "preview_worker_request" &&
          message.message.type === "preview_list_request"
            ? message.message.requestId
            : null,
        ),
    ).toEqual(["new-generation-list"]);
    expect(response(send, "old-generation-list")).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("close only detaches; a second client reuses the same worker identity and retained state", async () => {
    const path = await endpoint();
    const host = await worker(path);
    const first = client(path);
    first.attachment.register("serve-1");
    await list(first.attachment, "list-1");
    await vi.waitFor(() => expect(response(first.send, "list-1")).toBeDefined());
    const firstSocket = host.current();
    const messagesBeforeClose = host.received.length;
    first.attachment.close();
    await vi.waitFor(() => expect(host.current()).toBeNull());
    expect(host.server.listening).toBe(true);
    expect(host.received).toHaveLength(messagesBeforeClose);

    const second = client(path);
    second.attachment.register("serve-2");
    await list(second.attachment, "list-2");
    await vi.waitFor(() => expect(response(second.send, "list-2")).toBeDefined());
    expect(host.current()).not.toBe(firstSocket);
    expect(host.accepted).toHaveLength(2);
    expect(response(second.send, "list-2")).toMatchObject(host.snapshot);
    expect(response(first.send, "list-1")).toMatchObject(host.snapshot);
    expect(first.spawn).not.toHaveBeenCalled();
    expect(second.spawn).not.toHaveBeenCalled();
    await delay(600);
    expect(host.accepted).toHaveLength(2);
    expect(host.current()).toBe(host.accepted[1]);
  });

  it.each([
    { profile: "other-profile", protocolVersion: PREVIEW_WORKER_PROTOCOL_VERSION },
    { profile: PROFILE, protocolVersion: PREVIEW_WORKER_PROTOCOL_VERSION + 1 },
  ])(
    "rejects incompatible worker hello without configure, requests or repeated spawn: %j",
    async (identity) => {
      const path = await endpoint();
      const received: PreviewWorkerMessage[] = [];
      let connections = 0;
      await listen(path, (socket) => {
        connections += 1;
        readPreviewWorkerMessages(
          socket,
          (message) => {
            received.push(message);
            if (message.type === "serve_preview_hello")
              writePreviewWorkerMessage(socket, { ...HELLO, ...identity });
          },
          () => socket.destroy(),
        );
      });
      const { attachment, spawn, send } = client(path);
      await list(attachment, "rejected");
      attachment.start();
      await list(attachment, "still-rejected");
      await delay(600);
      expect(connections).toBe(1);
      expect(received.map((message) => message.type)).toEqual(["serve_preview_hello"]);
      expect(send).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("an incorrect Serve profile cannot evict a valid attachment or replace the existing listener", async () => {
    const path = await endpoint();
    const host = await worker(path);
    const owner = client(path);
    await list(owner.attachment, "owner-list");
    await vi.waitFor(() => expect(response(owner.send, "owner-list")).toBeDefined());
    const ownerSocket = host.current();
    const intruder = client(path, { profile: "wrong-profile" });
    await list(intruder.attachment, "wrong-list");
    await delay(600);
    intruder.attachment.close();
    expect(host.current()).toBe(ownerSocket);
    expect(host.accepted).toHaveLength(1);
    expect(host.errors.length).toBeGreaterThanOrEqual(1);
    expect(
      host.received.filter(
        ({ message }) =>
          message.type === "serve_preview_hello" && message.profile === "wrong-profile",
      ),
    ).toHaveLength(1);
    expect(intruder.spawn).not.toHaveBeenCalled();
    expect(intruder.send).not.toHaveBeenCalled();
    await list(owner.attachment, "owner-still-live");
    await vi.waitFor(() =>
      expect(response(owner.send, "owner-still-live")).toMatchObject(host.snapshot),
    );
  });

  it("a silent IPC reader times out without receiving state or taking over the active client", async () => {
    const path = await endpoint();
    const host = await worker(path, { timeoutMs: 80 });
    const owner = client(path);
    await list(owner.attachment, "owner-list");
    await vi.waitFor(() => expect(response(owner.send, "owner-list")).toBeDefined());
    const ownerSocket = host.current();
    const reader = track(createConnection(path));
    const data: Buffer[] = [];
    reader.on("data", (chunk: Buffer) => data.push(chunk));
    await new Promise<void>((resolve) => reader.once("close", () => resolve()));
    expect(data).toEqual([]);
    expect(host.current()).toBe(ownerSocket);
    expect(host.accepted).toHaveLength(1);
    expect(host.disconnect).not.toHaveBeenCalled();
  });

  it("the client bounds a worker that accepts its socket but never sends a hello", async () => {
    const path = await endpoint();
    const messages: PreviewWorkerMessage[] = [];
    let candidate: Socket | undefined;
    await listen(path, (socket) => {
      candidate = socket;
      readPreviewWorkerMessages(
        socket,
        (message) => messages.push(message),
        () => socket.destroy(),
      );
    });
    const { attachment, spawn, send } = client(path);
    const request = list(attachment, "silent-worker");
    await request;
    attachment.close();
    await vi.waitFor(() => expect(candidate?.destroyed).toBe(true));
    expect(messages.map((message) => message.type)).toEqual(["serve_preview_hello"]);
    expect(send).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  }, 8_000);

  it("retries a disconnected attachment with the latest Relay configuration, then close cancels retry", async () => {
    const path = await endpoint();
    const host = await worker(path);
    const { attachment, spawn, send } = client(path);
    attachment.register("serve-1");
    await list(attachment, "before-drop");
    await vi.waitFor(() => expect(response(send, "before-drop")).toBeDefined());
    host.current()!.destroy();
    attachment.register("serve-2");
    await vi.waitFor(() => expect(host.accepted).toHaveLength(2), { timeout: 2_000 });
    await vi.waitFor(() =>
      expect(host.received.at(-1)?.message).toEqual({
        type: "preview_worker_configure",
        relay: { ...RELAY, connectionId: "serve-2" },
      }),
    );
    await list(attachment, "after-drop");
    await vi.waitFor(() => expect(response(send, "after-drop")).toMatchObject(host.snapshot));
    host.current()!.destroy();
    attachment.close();
    await delay(650);
    expect(host.accepted).toHaveLength(2);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("close cancels an unacknowledged candidate and an absent-worker startup wait", async () => {
    const path = await endpoint();
    const host = await worker(path, { automaticHello: false });
    const pendingHello = client(path);
    const helloRequest = list(pendingHello.attachment, "pending-hello");
    await vi.waitFor(() => expect(host.accepted).toHaveLength(1));
    pendingHello.attachment.close();
    await helloRequest;
    await vi.waitFor(() => expect(host.current()).toBeNull());
    expect(host.received.map(({ message }) => message.type)).toEqual(["serve_preview_hello"]);

    const missingPath = await endpoint();
    const pendingSpawn = client(missingPath, { startupTimeoutMs: 5_000 });
    const startupRequest = list(pendingSpawn.attachment, "pending-startup");
    await vi.waitFor(() => expect(pendingSpawn.spawn).toHaveBeenCalledOnce());
    pendingSpawn.attachment.close();
    const lateWorker = await worker(missingPath);
    await startupRequest;
    await delay(650);
    expect(pendingSpawn.spawn).toHaveBeenCalledOnce();
    expect(pendingSpawn.send).not.toHaveBeenCalled();
    expect(lateWorker.connections).toHaveLength(0);
    expect(host.accepted).toHaveLength(1);
  });

  it("uses portable, profile-scoped Unix sockets and Windows named-pipe endpoint names", () => {
    const posix = "/tmp/profiles/qa/preview-worker.sock";
    expect(localIpcEndpointPath(posix, "darwin")).toBe(posix);
    expect(localIpcEndpointPath(posix, "linux")).toBe(posix);
    const windows = localIpcEndpointPath("C:\\test\\profiles\\qa\\preview-worker.sock", "win32");
    expect(windows).toMatch(/^\\\\\.\\pipe\\dev-anywhere-[a-f0-9]{64}$/);
    expect(windows).toBe(localIpcEndpointPath("c:/test/profiles/qa/preview-worker.sock", "win32"));
    expect(windows).not.toBe(
      localIpcEndpointPath("C:\\test\\profiles\\prod\\preview-worker.sock", "win32"),
    );
  });
});
