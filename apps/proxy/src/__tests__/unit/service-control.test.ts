import { mkdtempSync, rmSync, statSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestServiceControl,
  startServiceControl,
  type ServiceStatus,
} from "#src/common/service-control.js";
import { localIpcEndpointPath } from "#src/common/paths.js";

const roots: string[] = [];
const cleanups: Array<() => void> = [];
const status: ServiceStatus = {
  pid: process.pid,
  instanceId: "test-service",
  profile: "test",
  version: "0.9.2",
  state: "ready",
};

function socketPath(): string {
  const root = mkdtempSync(join(tmpdir(), "da-control-"));
  roots.push(root);
  return localIpcEndpointPath(join(root, "control.sock"));
}

async function rawServer(path: string, handle: (socket: Socket) => void): Promise<Server> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    handle(socket);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  cleanups.push(() => {
    server.close();
    for (const socket of sockets) socket.destroy();
  });
  return server;
}

async function managedServer(path: string, onStop = vi.fn(), value = status) {
  const server = await startServiceControl({ socketPath: path, getStatus: () => value, onStop });
  cleanups.push(() => server.close());
  return { server, onStop };
}

function rawRequest(path: string, data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let response = "";
    socket.once("connect", () => socket.write(data));
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(response));
  });
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("service control", () => {
  it("reports a missing endpoint as absent", async () => {
    await expect(requestServiceControl(socketPath(), "status")).resolves.toBeNull();
  });

  it("reports independently validated status with a private control socket", async () => {
    const path = socketPath();
    await managedServer(path);
    await expect(requestServiceControl(path, "status")).resolves.toEqual(status);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("acknowledges stop and dispatches shutdown only once", async () => {
    const path = socketPath();
    const { onStop } = await managedServer(path);
    await expect(requestServiceControl(path, "stop")).resolves.toMatchObject({ state: "stopping" });
    await expect(requestServiceControl(path, "stop")).resolves.toMatchObject({ state: "stopping" });
    await expect(requestServiceControl(path, "status")).resolves.toMatchObject({
      state: "stopping",
    });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("sends no service information to a client that has not written a request", async () => {
    const path = socketPath();
    const { onStop } = await managedServer(path);
    const socket = connect(path);
    const onData = vi.fn();
    socket.on("data", onData);
    socket.on("error", () => {});
    cleanups.push(() => socket.destroy());
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    await sleep(30);
    expect(onData).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });

  it("does not require optional session details in order to stop", async () => {
    const path = socketPath();
    const { onStop } = await managedServer(path, vi.fn(), {
      ...status,
      info: { invalid: "x".repeat(1024 * 1024) } as unknown as ServiceStatus["info"],
    });
    await expect(requestServiceControl(path, "stop")).resolves.toMatchObject({ state: "stopping" });
    await vi.waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
  });

  it("keeps lifecycle status usable when optional display details change", async () => {
    const path = socketPath();
    await managedServer(path, vi.fn(), {
      ...status,
      info: { future: "display details" } as unknown as ServiceStatus["info"],
    });
    await expect(requestServiceControl(path, "status")).resolves.toEqual(status);
  });

  it("rejects unsupported command envelopes without stopping", async () => {
    const path = socketPath();
    const { onStop } = await managedServer(path);
    const response = await rawRequest(path, '{"version":2,"action":"stop"}\n');
    expect(JSON.parse(response)).toHaveProperty("error");
    expect(onStop).not.toHaveBeenCalled();
  });

  it("rejects extra commands in a frame without executing either", async () => {
    const path = socketPath();
    const { onStop } = await managedServer(path);
    await rawRequest(path, '{"version":1,"action":"status"}\n{"version":1,"action":"stop"}\n');
    expect(onStop).not.toHaveBeenCalled();
  });

  it("bounds incomplete requests without calling the service", async () => {
    const path = socketPath();
    const { onStop } = await managedServer(path);
    expect(await rawRequest(path, "x".repeat(16 * 1024 + 1))).toBe("");
    expect(onStop).not.toHaveBeenCalled();
  });

  it("rejects connections beyond the bounded pending-command capacity", async () => {
    const path = socketPath();
    await managedServer(path);
    const sockets = Array.from({ length: 64 }, () => connect(path));
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
    });
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
          }),
      ),
    );
    await expect(requestServiceControl(path, "status", 500)).rejects.toThrow("without a response");
  });

  it("reassembles a fragmented response", async () => {
    const path = socketPath();
    await rawServer(path, (socket) => {
      socket.once("data", () => {
        const response = JSON.stringify({ version: 1, service: status });
        socket.write(response.slice(0, 10));
        setImmediate(() => socket.end(`${response.slice(10)}\n`));
      });
    });
    await expect(requestServiceControl(path, "status")).resolves.toEqual(status);
  });

  it("does not treat a connected service with no response as absent", async () => {
    const path = socketPath();
    await rawServer(path, () => {});
    await expect(requestServiceControl(path, "status", 30)).rejects.toThrow("timed out");
  });

  it("does not treat an empty response as absence", async () => {
    const path = socketPath();
    await rawServer(path, (socket) => socket.end());
    await expect(requestServiceControl(path, "status")).rejects.toThrow("without a response");
  });

  it.each([
    "not-json\n",
    '{"version":2,"service":{}}\n',
    `${JSON.stringify({ version: 1, service: { ...status, pid: -1 } })}\n`,
  ])("rejects invalid responses: %s", async (response) => {
    const path = socketPath();
    await rawServer(path, (socket) => socket.end(response));
    await expect(requestServiceControl(path, "status")).rejects.toThrow(
      "Invalid service control response",
    );
  });

  it("bounds response memory even before a newline", async () => {
    const path = socketPath();
    await rawServer(path, (socket) => socket.end("x".repeat(1024 * 1024 + 1)));
    await expect(requestServiceControl(path, "status")).rejects.toThrow("size limit");
  });

  it("rejects invalid client timeout values", async () => {
    await expect(requestServiceControl(socketPath(), "status", 0)).rejects.toThrow(
      "Invalid service control timeout",
    );
  });
});
