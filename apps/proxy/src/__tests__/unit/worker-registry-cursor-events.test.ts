import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessageEnvelopeSchema, RelayControlSchema } from "@dev-anywhere/shared";
import { serializeWorkerMsg, WorkerMessageSchema } from "#src/ipc/ipc-protocol.js";
import { WorkerRegistry } from "#src/serve/worker-registry.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import {
  createJsonObserverFake,
  createRelayConnectionFake,
  createSessionManagerFake,
  serializeWorkerHandshake,
} from "./test-fakes.js";

function acpUpdate(sessionUpdate: string, fields: Record<string, unknown>) {
  return {
    type: "cursor_acp",
    method: "session/update",
    params: { sessionId: "cursor-native-1", update: { sessionUpdate, ...fields } },
  };
}

describe("WorkerRegistry Cursor ACP events", () => {
  let server: Server;
  let acceptedSocket: Socket | null = null;
  let tempDir: string;
  let sockPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "worker-cursor-"));
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

  async function createConnectedRegistry() {
    const relay = createRelayConnectionFake();
    const permissionBroker = new PermissionBroker();
    const onTurnResult = vi.fn();
    const sessionManager = createSessionManagerFake([
      {
        id: "s1",
        kind: "agent",
        mode: "json",
        provider: "cursor",
        state: "idle",
        createdAt: 1,
        updatedAt: 1,
        cwd: "/tmp",
        pid: 1,
      },
    ]);
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker,
      relayConnection: relay.relayConnection,
      jsonObserver: createJsonObserverFake({ onTurnResult }),
      getProviderEnv: () => ({}),
    });
    expect(await registry.connect("s1", sockPath)).not.toBeNull();
    if (!acceptedSocket) throw new Error("worker socket was not accepted");
    const daemonHello = await new Promise<string>((resolve) => {
      acceptedSocket?.once("data", (chunk) => resolve(chunk.toString()));
    });
    expect(WorkerMessageSchema.parse(JSON.parse(daemonHello.trim()))).toMatchObject({
      type: "serve_protocol_hello",
      sessionId: "s1",
    });
    acceptedSocket?.write(
      serializeWorkerHandshake("s1", 1, "cursor", { type: "worker_ready", pid: 321 }),
    );
    await registry.waitForReady("s1", 1_000);
    return { relay, onTurnResult };
  }

  it("streams Cursor text and forwards todo UI updates", async () => {
    const { relay, onTurnResult } = await createConnectedRegistry();

    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 1,
        event: acpUpdate("agent_message_chunk", {
          content: { type: "text", text: "好" },
        }),
      }),
    );
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 2,
        event: {
          type: "cursor_acp",
          method: "cursor/update_todos",
          params: {
            merge: false,
            todos: [{ id: "1", content: "Write tests", status: "pending" }],
          },
        },
      }),
    );
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 3,
        event: {
          type: "cursor_acp",
          method: "session/prompt/result",
          params: { response: { stopReason: "end_turn" } },
        },
      }),
    );

    await vi.waitFor(() => expect(relay.raw.length).toBeGreaterThanOrEqual(2));
    expect(relay.envelopes.map((envelope) => MessageEnvelopeSchema.parse(envelope))).toEqual([
      expect.objectContaining({
        type: "assistant_message",
        payload: expect.objectContaining({ text: "好" }),
      }),
      expect.objectContaining({
        type: "assistant_message",
        payload: expect.objectContaining({ text: "好", status: "completed" }),
      }),
    ]);
    expect(relay.raw.map((raw) => RelayControlSchema.parse(JSON.parse(raw)))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "cursor_session_ui" }),
        expect.objectContaining({ type: "turn_result", success: true }),
      ]),
    );
    expect(onTurnResult).toHaveBeenCalledWith("s1");
  });
});
