import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayControlSchema } from "@dev-anywhere/shared";
import { WORKER_IPC_PROTOCOL_VERSION, serializeWorkerMsg } from "#src/ipc/ipc-protocol.js";
import { WorkerRegistry } from "#src/serve/worker-registry.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import type { SessionInfo } from "#src/serve/session-manager.js";
import {
  createJsonObserverFake,
  createRelayConnectionFake,
  createSessionManagerFake,
  serializeWorkerHandshake,
} from "./test-fakes.js";

const currentJsonSession = {
  id: "s1",
  kind: "agent",
  mode: "json",
  provider: "claude",
  state: "idle",
  createdAt: 1,
  updatedAt: 1,
  cwd: "/tmp",
  pid: 1,
} satisfies SessionInfo;

// 单独测 onDisconnect → onChannelBroken 路径：worker socket 异常断开时
// 必须把仍在 manager 中的 session 推到 ERROR，避免 UI 长时间停留 WORKING/WAITING_APPROVAL。
describe("WorkerRegistry onDisconnect", () => {
  let server: Server;
  let acceptedSocket: Socket | null = null;
  let sockPath: string;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "wr-disc-"));
    sockPath = join(tempDir, "worker.sock");
    server = createServer((sock) => {
      acceptedSocket = sock;
    });
    await new Promise<void>((resolve) => server.listen(sockPath, () => resolve()));
  });

  afterEach(async () => {
    acceptedSocket?.destroy();
    acceptedSocket = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("invokes jsonObserver.onChannelBroken when socket closes while session still alive", async () => {
    const onChannelBroken = vi.fn();
    const sessionManager = createSessionManagerFake([currentJsonSession]);
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake({ onChannelBroken }),
      getProviderEnv: () => ({}),
    });

    const sock = await registry.connect("s1", sockPath);
    expect(sock).not.toBeNull();
    if (!sock) throw new Error("worker socket did not connect");

    // server 端主动 destroy 模拟 worker 进程崩溃
    const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
    acceptedSocket?.destroy();
    await closed;

    expect(onChannelBroken).toHaveBeenCalledWith("s1");
  });

  it("does not invoke onChannelBroken when session has already been terminated (worker_exit cleanup path)", async () => {
    const onChannelBroken = vi.fn();
    const sessionManager = createSessionManagerFake([]); // session 不在 manager 中（已被 terminate）
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake({ onChannelBroken }),
      getProviderEnv: () => ({}),
    });

    const sock = await registry.connect("s-gone", sockPath);
    expect(sock).not.toBeNull();
    if (!sock) throw new Error("worker socket did not connect");

    const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
    acceptedSocket?.destroy();
    await closed;

    // worker_exit 路径会先 terminateSession（删除 session），随后 socket close 触发到这里：
    // 此时 session 已不在，避免重复推送 ERROR（实际上 ERROR 转换会被 FSM 拒绝，但更早 short-circuit 减少噪音）。
    expect(onChannelBroken).not.toHaveBeenCalled();
  });

  it("resolves waitForReady when worker_ready arrives", async () => {
    const registry = new WorkerRegistry({
      sessionManager: createSessionManagerFake([currentJsonSession]),
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
    });

    const ready = registry.waitForReady("s1", 1000);
    const sock = await registry.connect("s1", sockPath);
    expect(sock).not.toBeNull();
    expect(registry.has("s1")).toBe(false);
    expect(registry.send("s1", { type: "worker_input", content: "before handshake" })).toBe(false);

    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_protocol_hello",
        protocolVersion: WORKER_IPC_PROTOCOL_VERSION,
        sessionId: "s1",
        provider: "claude",
        pid: 1,
      }),
    );
    expect(registry.has("s1")).toBe(false);
    expect(registry.send("s1", { type: "worker_input", content: "after hello" })).toBe(false);
    acceptedSocket?.write(serializeWorkerMsg({ type: "worker_ready", pid: 12345 }));

    await expect(ready).resolves.toBeUndefined();
    expect(registry.has("s1")).toBe(true);
    expect(registry.send("s1", { type: "worker_input", content: "after handshake" })).toBe(true);
  });

  it.each([
    [
      "missing-version",
      { type: "worker_protocol_hello", sessionId: "s1", provider: "claude", pid: 1 },
    ],
    [
      "wrong-version",
      {
        type: "worker_protocol_hello",
        protocolVersion: 0,
        sessionId: "s1",
        provider: "claude",
        pid: 1,
      },
    ],
    [
      "wrong-session",
      {
        type: "worker_protocol_hello",
        protocolVersion: WORKER_IPC_PROTOCOL_VERSION,
        sessionId: "another-session",
        provider: "claude",
        pid: 1,
      },
    ],
    [
      "wrong-pid",
      {
        type: "worker_protocol_hello",
        protocolVersion: WORKER_IPC_PROTOCOL_VERSION,
        sessionId: "s1",
        provider: "claude",
        pid: 999,
      },
    ],
    [
      "wrong-provider",
      {
        type: "worker_protocol_hello",
        protocolVersion: WORKER_IPC_PROTOCOL_VERSION,
        sessionId: "s1",
        provider: "kimi",
        pid: 1,
      },
    ],
  ])("rejects a %s worker protocol hello and removes its session", async (_label, hello) => {
    const sessionManager = createSessionManagerFake([currentJsonSession]);
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
    });

    const readyResult = registry.waitForReady("s1", 1_000);
    expect(await registry.connect("s1", sockPath)).not.toBeNull();
    acceptedSocket?.write(`${JSON.stringify(hello)}\n`);

    await expect(readyResult).rejects.toThrow(/protocol handshake rejected/i);
    expect(sessionManager.terminateSession).toHaveBeenCalledWith("s1");
    expect(registry.has("s1")).toBe(false);
  });

  it.each([
    ["readiness", { type: "worker_ready", pid: 12345 }],
    [
      "startup error",
      { type: "worker_startup_error", provider: "claude", message: "bootstrap failed" },
    ],
    ["exit", { type: "worker_exit", code: 1 }],
    ["business event", { type: "worker_event", seq: 1, event: { type: "result" } }],
  ])("rejects a pre-hello %s message", async (_label, message) => {
    const sessionManager = createSessionManagerFake([currentJsonSession]);
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
    });

    const readyResult = registry.waitForReady("s1", 1_000);
    expect(await registry.connect("s1", sockPath)).not.toBeNull();
    acceptedSocket?.write(`${JSON.stringify(message)}\n`);

    await expect(readyResult).rejects.toThrow(/protocol handshake rejected/i);
    expect(sessionManager.terminateSession).toHaveBeenCalledWith("s1");
    expect(registry.has("s1")).toBe(false);
  });

  it("delivers a provider bootstrap error only after a valid protocol hello", async () => {
    const sessionManager = createSessionManagerFake([currentJsonSession]);
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
    });

    const readyResult = registry.waitForReady("s1", 1_000);
    expect(await registry.connect("s1", sockPath)).not.toBeNull();
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_protocol_hello",
        protocolVersion: WORKER_IPC_PROTOCOL_VERSION,
        sessionId: "s1",
        provider: "claude",
        pid: 1,
      }),
    );
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_startup_error",
        provider: "claude",
        message: "provider bootstrap failed",
      }),
    );

    await expect(readyResult).rejects.toThrow("provider bootstrap failed");
    expect(sessionManager.terminateSession).not.toHaveBeenCalled();
  });

  it("rejects a provider identity change after a valid protocol hello", async () => {
    const sessionManager = createSessionManagerFake([currentJsonSession]);
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
    });

    const readyResult = registry.waitForReady("s1", 1_000);
    expect(await registry.connect("s1", sockPath)).not.toBeNull();
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_protocol_hello",
        protocolVersion: WORKER_IPC_PROTOCOL_VERSION,
        sessionId: "s1",
        provider: "claude",
        pid: 1,
      }),
    );
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_startup_error",
        provider: "codex",
        message: "wrong provider",
      }),
    );

    await expect(readyResult).rejects.toThrow(/protocol handshake rejected/i);
    expect(sessionManager.terminateSession).toHaveBeenCalledWith("s1");
  });

  it("rejects worker business messages before provider readiness", async () => {
    const sessionManager = createSessionManagerFake([currentJsonSession]);
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
    });

    const readyResult = registry.waitForReady("s1", 1_000);
    expect(await registry.connect("s1", sockPath)).not.toBeNull();
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_protocol_hello",
        protocolVersion: WORKER_IPC_PROTOCOL_VERSION,
        sessionId: "s1",
        provider: "claude",
        pid: 1,
      }),
    );
    acceptedSocket?.write(
      serializeWorkerMsg({ type: "worker_event", seq: 1, event: { type: "result" } }),
    );

    await expect(readyResult).rejects.toThrow(/protocol handshake rejected/i);
    expect(sessionManager.terminateSession).toHaveBeenCalledWith("s1");
  });

  it("rejects a second protocol hello on the same socket", async () => {
    const sessionManager = createSessionManagerFake([currentJsonSession]);
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
    });
    const hello = serializeWorkerMsg({
      type: "worker_protocol_hello",
      protocolVersion: WORKER_IPC_PROTOCOL_VERSION,
      sessionId: "s1",
      provider: "claude",
      pid: 1,
    });

    const readyResult = registry.waitForReady("s1", 1_000);
    expect(await registry.connect("s1", sockPath)).not.toBeNull();
    acceptedSocket?.write(hello);
    acceptedSocket?.write(hello);

    await expect(readyResult).rejects.toThrow(/protocol handshake rejected/i);
    expect(sessionManager.terminateSession).toHaveBeenCalledWith("s1");
    expect(registry.has("s1")).toBe(false);
  });

  it("rejects waitForReady when the worker socket closes before ready", async () => {
    const registry = new WorkerRegistry({
      sessionManager: createSessionManagerFake([currentJsonSession]),
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
    });

    const ready = registry.waitForReady("s1", 1000);
    const sock = await registry.connect("s1", sockPath);
    expect(sock).not.toBeNull();

    acceptedSocket?.destroy();

    await expect(ready).rejects.toThrow(/disconnected before ready/i);
  });

  it("turns worker_interrupted into a non-terminating JSON turn_result", async () => {
    const onTurnResult = vi.fn();
    const sessionManager = createSessionManagerFake([currentJsonSession]);
    const relay = createRelayConnectionFake();
    const permissionBroker = new PermissionBroker();
    const approvalDecision = vi.fn();
    permissionBroker.registerWorkerRequest(
      {
        requestId: "req-1",
        sessionId: "s1",
        provider: "claude",
        toolName: "Bash",
        input: { command: "pwd" },
      },
      approvalDecision,
    );
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker,
      relayConnection: relay.relayConnection,
      jsonObserver: createJsonObserverFake({ onTurnResult }),
      getProviderEnv: () => ({}),
    });

    const sock = await registry.connect("s1", sockPath);
    expect(sock).not.toBeNull();
    acceptedSocket?.write(
      serializeWorkerHandshake("s1", 1, "claude", {
        type: "worker_ready",
        pid: 12345,
      }),
    );
    await registry.waitForReady("s1", 1_000);

    acceptedSocket?.write(serializeWorkerMsg({ type: "worker_interrupted" }));

    await vi.waitFor(() => expect(onTurnResult).toHaveBeenCalledWith("s1"));
    expect(sessionManager.terminateSession).not.toHaveBeenCalled();
    expect(approvalDecision).toHaveBeenCalledWith({
      behavior: "deny",
      message: "Turn interrupted",
    });
    expect(permissionBroker.listSession("s1")).toEqual([]);

    const pendingClear = RelayControlSchema.parse(JSON.parse(relay.raw.at(-2)!));
    expect(pendingClear).toMatchObject({
      type: "pending_approvals_push",
      sessionId: "s1",
      approvals: [],
    });
    const turnResult = RelayControlSchema.parse(JSON.parse(relay.raw.at(-1)!));
    expect(turnResult).toMatchObject({
      type: "turn_result",
      sessionId: "s1",
      success: false,
      isError: true,
    });
  });
});
