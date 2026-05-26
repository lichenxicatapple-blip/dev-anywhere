import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RelayControlSchema } from "@dev-anywhere/shared";
import { serializeWorkerMsg } from "#src/ipc/ipc-protocol.js";
import { WorkerRegistry } from "#src/serve/worker-registry.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import {
  createJsonObserverFake,
  createRelayConnectionFake,
  createSessionManagerFake,
} from "./test-fakes.js";

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
    const sessionManager = createSessionManagerFake([{ id: "s1", mode: "json" }]);
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: createRelayConnectionFake().relayConnection,
      jsonObserver: createJsonObserverFake({ onChannelBroken }),
      getProviderEnv: () => ({}),
    });

    const sock = await registry.connect("s1", sockPath);
    expect(sock).not.toBeNull();

    // server 端主动 destroy 模拟 worker 进程崩溃
    acceptedSocket?.destroy();
    await new Promise((r) => setTimeout(r, 50));

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

    acceptedSocket?.destroy();
    await new Promise((r) => setTimeout(r, 50));

    // worker_exit 路径会先 terminateSession（删除 session），随后 socket close 触发到这里：
    // 此时 session 已不在，避免重复推送 ERROR（实际上 ERROR 转换会被 FSM 拒绝，但更早 short-circuit 减少噪音）。
    expect(onChannelBroken).not.toHaveBeenCalled();
  });

  it("turns worker_interrupted into a non-terminating JSON turn_result", async () => {
    const onTurnResult = vi.fn();
    const sessionManager = createSessionManagerFake([{ id: "s1", mode: "json" }]);
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

    acceptedSocket?.write(serializeWorkerMsg({ type: "worker_interrupted" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(onTurnResult).toHaveBeenCalledWith("s1");
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
