import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionState } from "@dev-anywhere/shared";
import { WorkerRegistry } from "#src/serve/worker-registry.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { serializeWorkerMsg } from "#src/ipc/ipc-protocol.js";
import {
  createJsonObserverFake,
  createRelayConnectionFake,
  createSessionManagerFake,
} from "./test-fakes.js";

describe("WorkerRegistry compact command events", () => {
  let server: Server;
  let acceptedSocket: Socket | null = null;
  let tempDir: string;
  let sockPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "worker-compact-"));
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

  function createRegistry() {
    const relay = createRelayConnectionFake();
    const onTurnResult = vi.fn();
    const registry = new WorkerRegistry({
      sessionManager: createSessionManagerFake([
        { id: "s1", mode: "json", state: SessionState.COMPACTING },
      ]),
      permissionBroker: new PermissionBroker(),
      relayConnection: relay.relayConnection,
      jsonObserver: createJsonObserverFake({ onTurnResult }),
      getProviderEnv: () => ({}),
    });
    return { registry, relay, onTurnResult };
  }

  async function connectAndWrite(registry: WorkerRegistry, event: Record<string, unknown>) {
    const sock = await registry.connect("s1", sockPath);
    expect(sock).not.toBeNull();
    acceptedSocket?.write(serializeWorkerMsg({ type: "worker_event", seq: 7, event }));
  }

  it("surfaces compact local_command failures and returns the session to idle", async () => {
    const { registry, relay, onTurnResult } = createRegistry();

    await connectAndWrite(registry, {
      type: "system",
      subtype: "local_command",
      content:
        "<local-command-stderr>Error: Error during compaction: API Error: 502 upstream disconnected</local-command-stderr>",
    });

    await vi.waitFor(() => expect(onTurnResult).toHaveBeenCalledWith("s1"));
    expect(relay.envelopes).toHaveLength(1);
    expect(relay.envelopes[0]).toMatchObject({
      type: "assistant_message",
      sessionId: "s1",
      payload: {
        text: "上下文压缩失败：API Error: 502 upstream disconnected",
        isPartial: true,
      },
    });
    expect(relay.raw).toHaveLength(1);
    expect(JSON.parse(relay.raw[0])).toMatchObject({
      type: "turn_result",
      sessionId: "s1",
      success: false,
      isError: true,
      result: "上下文压缩失败：API Error: 502 upstream disconnected",
    });
    expect(onTurnResult).toHaveBeenCalledWith("s1");
  });

  it("handles compact success emitted as a string user local-command stdout", async () => {
    const { registry, relay, onTurnResult } = createRegistry();

    await connectAndWrite(registry, {
      type: "user",
      message: {
        role: "user",
        content:
          "<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m</local-command-stdout>",
      },
    });

    await vi.waitFor(() => expect(onTurnResult).toHaveBeenCalledWith("s1"));
    expect(relay.envelopes).toHaveLength(1);
    expect(relay.envelopes[0]).toMatchObject({
      type: "assistant_message",
      payload: { text: "上下文压缩完成。", isPartial: true },
    });
    expect(JSON.parse(relay.raw[0])).toMatchObject({
      type: "turn_result",
      success: true,
      isError: false,
      result: "上下文压缩完成。",
    });
    expect(onTurnResult).toHaveBeenCalledWith("s1");
  });

  it("keeps compacting status events invisible until a terminal compact outcome arrives", async () => {
    const { registry, relay, onTurnResult } = createRegistry();

    await connectAndWrite(registry, {
      type: "system",
      subtype: "status",
      status: "compacting",
    });

    await new Promise((resolve) => setImmediate(resolve));
    expect(relay.envelopes).toHaveLength(0);
    expect(relay.raw).toHaveLength(0);
    expect(onTurnResult).not.toHaveBeenCalled();
  });
});
