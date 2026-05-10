import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
