import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RelayControlSchema } from "@dev-anywhere/shared";
import { serializeWorkerMsg } from "#src/ipc/ipc-protocol.js";
import { WorkerRegistry } from "#src/serve/worker-registry.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import {
  createJsonObserverFake,
  createRelayConnectionFake,
  createSessionManagerFake,
} from "./test-fakes.js";

describe("WorkerRegistry Codex app-server events", () => {
  let server: Server;
  let acceptedSocket: Socket | null = null;
  let tempDir: string;
  let sockPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "worker-codex-"));
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
    const onTurnResult = vi.fn();
    const sessionManager = createSessionManagerFake([
      { id: "s1", mode: "json", provider: "codex" },
    ]);
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker: new PermissionBroker(),
      relayConnection: relay.relayConnection,
      jsonObserver: createJsonObserverFake({ onTurnResult }),
      getProviderEnv: () => ({}),
    });
    const sock = await registry.connect("s1", sockPath);
    expect(sock).not.toBeNull();
    return { relay, onTurnResult, sessionManager };
  }

  it("forwards Codex agent message deltas as assistant messages", async () => {
    const { relay } = await createConnectedRegistry();

    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 11,
        event: {
          type: "codex_app_server",
          method: "item/agentMessage/delta",
          params: { threadId: "cx-1", turnId: "turn-1", itemId: "msg-1", delta: "OK" },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(relay.envelopes[0]).toMatchObject({
      type: "assistant_message",
      sessionId: "s1",
      seq: 11,
      payload: { text: "OK", isPartial: true },
    });
  });

  it("turns Codex turn/completed into a JSON turn_result", async () => {
    const { relay, onTurnResult } = await createConnectedRegistry();

    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 12,
        event: {
          type: "codex_app_server",
          method: "turn/completed",
          params: {
            threadId: "cx-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(RelayControlSchema.parse(JSON.parse(relay.raw[0]))).toMatchObject({
      type: "turn_result",
      sessionId: "s1",
      success: true,
      isError: false,
    });
    expect(onTurnResult).toHaveBeenCalledWith("s1");
  });

  it("maps Codex commandExecution items to tool use and tool result envelopes", async () => {
    const { relay } = await createConnectedRegistry();

    const item = {
      type: "commandExecution",
      id: "cmd-1",
      command: "pwd",
      cwd: "/tmp/project",
      status: "completed",
      aggregatedOutput: "/tmp/project\n",
      exitCode: 0,
    };
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 13,
        event: {
          type: "codex_app_server",
          method: "item/started",
          params: { threadId: "cx-1", turnId: "turn-1", item },
        },
      }),
    );
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 14,
        event: {
          type: "codex_app_server",
          method: "item/completed",
          params: { threadId: "cx-1", turnId: "turn-1", item },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(relay.envelopes[0]).toMatchObject({
      type: "assistant_tool_use",
      sessionId: "s1",
      seq: 13,
      payload: {
        toolName: "Bash",
        toolId: "cmd-1",
        parameters: { command: "pwd", cwd: "/tmp/project" },
      },
    });
    expect(relay.envelopes[1]).toMatchObject({
      type: "tool_result",
      sessionId: "s1",
      seq: 14,
      payload: { toolId: "cmd-1", result: "/tmp/project\n", isError: false },
    });
  });

  it("maps Codex fileChange items to patch activity envelopes", async () => {
    const { relay } = await createConnectedRegistry();

    const item = {
      type: "fileChange",
      id: "patch-1",
      status: "completed",
      changes: [
        {
          path: "/tmp/project/a.txt",
          kind: { type: "update", move_path: null },
          diff: "@@ -1 +1 @@\n-old\n+new\n",
        },
      ],
    };
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 15,
        event: {
          type: "codex_app_server",
          method: "item/completed",
          params: { threadId: "cx-1", turnId: "turn-1", item },
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(relay.envelopes[0]).toMatchObject({
      type: "assistant_tool_use",
      sessionId: "s1",
      seq: 15,
      payload: {
        toolName: "Patch",
        toolId: "patch-1",
        parameters: {
          file_path: "/tmp/project/a.txt",
          content: "@@ -1 +1 @@\n-old\n+new\n",
          changes: [
            {
              path: "/tmp/project/a.txt",
              kind: "update",
              diff: "@@ -1 +1 @@\n-old\n+new\n",
            },
          ],
        },
      },
    });
    expect(relay.envelopes[1]).toMatchObject({
      type: "tool_result",
      sessionId: "s1",
      seq: 15,
      payload: { toolId: "patch-1", result: "completed", isError: false },
    });
  });

  it("stores Codex native thread id as history session id", async () => {
    const { sessionManager } = await createConnectedRegistry();

    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_native_session_id",
        provider: "codex",
        sessionId: "cx-thread-1",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(sessionManager.setHistorySessionId).toHaveBeenCalledWith("s1", "cx-thread-1");
  });
});
