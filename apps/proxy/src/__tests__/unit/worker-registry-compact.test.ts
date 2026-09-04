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
  serializeWorkerHandshake,
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
        {
          id: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: SessionState.COMPACTING,
          createdAt: 1,
          updatedAt: 1,
          cwd: "/tmp",
          pid: 1,
        },
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
    acceptedSocket?.write(
      serializeWorkerHandshake("s1", 1, "claude", { type: "worker_ready", pid: 123 }),
    );
    await registry.waitForReady("s1", 1_000);
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
        status: "completed",
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

  it("aggregates Claude text deltas into growing full snapshots", async () => {
    const relay = createRelayConnectionFake();
    const registry = new WorkerRegistry({
      sessionManager: createSessionManagerFake([
        {
          id: "s1",
          kind: "agent",
          mode: "json",
          provider: "claude",
          state: "idle",
          createdAt: 1,
          updatedAt: 1,
          cwd: "/tmp",
          pid: 1,
        },
      ]),
      permissionBroker: new PermissionBroker(),
      relayConnection: relay.relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
    });
    const sock = await registry.connect("s1", sockPath);
    expect(sock).not.toBeNull();
    acceptedSocket?.write(
      serializeWorkerHandshake("s1", 1, "claude", { type: "worker_ready", pid: 123 }),
    );
    await registry.waitForReady("s1", 1_000);

    for (const [seq, text] of [
      [1, "完整"],
      [2, "回复"],
    ] as const) {
      acceptedSocket?.write(
        serializeWorkerMsg({
          type: "worker_event",
          seq,
          event: {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text },
            },
          },
        }),
      );
    }

    await vi.waitFor(() => expect(relay.envelopes).toHaveLength(2));
    expect(relay.envelopes.map((message) => (message as { payload: unknown }).payload)).toEqual([
      expect.objectContaining({ revision: 1, text: "完整", status: "streaming" }),
      expect.objectContaining({ revision: 2, text: "完整回复", status: "streaming" }),
    ]);
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
      payload: expect.objectContaining({ text: "上下文压缩完成。", status: "completed" }),
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
