import { mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { localIpcEndpointPath } from "#src/common/paths.js";
import {
  localIpcEndpointMayExist,
  prepareLocalIpcEndpoint,
  removeLocalIpcEndpoint,
  setLocalIpcEndpointPermissions,
} from "#src/common/local-ipc-endpoint.js";
import { tryConnectSocket } from "#src/common/socket-connect.js";
import { readServeConnection, takeoverServeSocket } from "#src/worker/serve-socket-takeover.js";
import { serializeWorkerMsg, WORKER_IPC_PROTOCOL_VERSION } from "#src/ipc/ipc-protocol.js";

const roots: string[] = [];
const servers = new Set<Server>();
const sockets = new Set<Socket>();

function endpoint(): string {
  const root = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "da-ipc-"));
  roots.push(root);
  return localIpcEndpointPath(join(root, "nested", "worker.sock"));
}

function track(socket: Socket): Socket {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => sockets.delete(socket));
  return socket;
}

async function listen(path: string, accept: (socket: Socket) => void): Promise<Server> {
  prepareLocalIpcEndpoint(path);
  const server = createServer((socket) => accept(track(socket)));
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  setLocalIpcEndpointPermissions(path);
  return server;
}

async function client(path: string): Promise<{ socket: Socket; received: () => string }> {
  const socket = track(connect(path));
  let received = "";
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("utf8");
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return { socket, received: () => received };
}

function hello(sessionId = "fixture"): string {
  return serializeWorkerMsg({
    type: "serve_protocol_hello",
    protocolVersion: WORKER_IPC_PROTOCOL_VERSION,
    sessionId,
    pid: process.pid,
  });
}

async function workerListener(path: string): Promise<void> {
  let current: Socket | null = null;
  await listen(path, (socket) => {
    readServeConnection(
      socket,
      "fixture",
      {
        onAccepted: () => {
          current = takeoverServeSocket(current, socket);
          socket.write("accepted\nprivate-fixture-state\n");
        },
        onMessage: (message) => {
          if (current === socket && message.type === "worker_input") {
            socket.write(`echo:${message.content}\n`);
          }
        },
        onError: () => {},
      },
      150,
    );
  });
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native local IPC endpoint", () => {
  it("round-trips bytes, probes listeners and releases the endpoint on close", async () => {
    const path = endpoint();
    await expect(tryConnectSocket(path)).resolves.toBeNull();
    const server = await listen(path, (socket) =>
      socket.on("data", (data: Buffer) => socket.write(data)),
    );
    expect(localIpcEndpointMayExist(path)).toBe(true);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const peer = await client(path);
    peer.socket.write("round-trip");
    await expect.poll(peer.received).toBe("round-trip");
    const closed = new Promise<void>((resolve) => peer.socket.once("close", resolve));
    peer.socket.destroy();
    await closed;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.delete(server);
    removeLocalIpcEndpoint(path);
    await expect(tryConnectSocket(path)).resolves.toBeNull();
    await listen(path, (socket) => socket.end("new-listener"));
    const replacement = await client(path);
    await expect.poll(replacement.received).toBe("new-listener");
  });

  it("does not expose state or replace an active connection for silent and invalid clients", async () => {
    const path = endpoint();
    await workerListener(path);
    const active = await client(path);
    active.socket.write(hello());
    await expect.poll(active.received).toContain("private-fixture-state");
    const silent = await client(path);
    const invalid = await client(path);
    // A second frame in the same read must not admit a connection rejected by its first frame.
    invalid.socket.write(
      serializeWorkerMsg({ type: "worker_input", content: "invalid-first-frame" }) + hello(),
    );
    const wrongSession = await client(path);
    wrongSession.socket.write(hello("other-session"));
    const malformed = await client(path);
    malformed.socket.write("not-json\n" + hello());
    await expect
      .poll(
        () =>
          invalid.socket.destroyed &&
          wrongSession.socket.destroyed &&
          silent.socket.destroyed &&
          malformed.socket.destroyed,
      )
      .toBe(true);
    expect(silent.received()).toBe("");
    expect(invalid.received()).toBe("");
    expect(wrongSession.received()).toBe("");
    expect(malformed.received()).toBe("");
    expect(active.socket.destroyed).toBe(false);
    active.socket.write(serializeWorkerMsg({ type: "worker_input", content: "still-active" }));
    await expect.poll(active.received).toContain("echo:still-active");
  });

  it("admits fragmented hello and replaces the previous connection only after negotiation", async () => {
    const path = endpoint();
    await workerListener(path);
    const active = await client(path);
    active.socket.write(hello());
    await expect.poll(active.received).toContain("accepted");
    const next = await client(path);
    const frame = hello();
    next.socket.write(frame.slice(0, 10));
    await sleep(20);
    expect(next.received()).toBe("");
    expect(active.socket.destroyed).toBe(false);
    next.socket.write(frame.slice(10));
    await expect.poll(next.received).toContain("private-fixture-state");
    await expect.poll(() => active.socket.destroyed).toBe(true);
    next.socket.write(serializeWorkerMsg({ type: "worker_input", content: "reconnected" }));
    await expect.poll(next.received).toContain("echo:reconnected");
  });
});
