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
    type: "kimi_acp",
    method: "session/update",
    params: { sessionId: "kimi-native-1", update: { sessionUpdate, ...fields } },
  };
}

describe("WorkerRegistry Kimi ACP events", () => {
  let server: Server;
  let acceptedSocket: Socket | null = null;
  let tempDir: string;
  let sockPath: string;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "worker-kimi-"));
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

  async function createConnectedRegistry(
    sessions = [
      {
        id: "s1",
        kind: "agent" as const,
        mode: "json" as const,
        provider: "kimi" as const,
        state: "idle" as const,
        createdAt: 1,
        updatedAt: 1,
        cwd: "/tmp",
        pid: 1,
      },
    ],
  ) {
    const relay = createRelayConnectionFake();
    const permissionBroker = new PermissionBroker();
    const onTurnStart = vi.fn();
    const onTurnResult = vi.fn();
    const onApprovalRequested = vi.fn();
    const setProviderCommands = vi.fn();
    const sessionManager = createSessionManagerFake(sessions);
    const registry = new WorkerRegistry({
      sessionManager,
      permissionBroker,
      relayConnection: relay.relayConnection,
      jsonObserver: createJsonObserverFake({ onTurnStart, onTurnResult, onApprovalRequested }),
      getProviderEnv: () => ({}),
      setProviderCommands,
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
      serializeWorkerHandshake("s1", 1, "kimi", { type: "worker_ready", pid: 321 }),
    );
    await registry.waitForReady("s1", 1_000);
    return {
      registry,
      relay,
      permissionBroker,
      sessionManager,
      onTurnStart,
      onTurnResult,
      onApprovalRequested,
      setProviderCommands,
    };
  }

  it("streams Kimi text as growing assistant snapshots and completes the turn", async () => {
    const { relay, onTurnResult } = await createConnectedRegistry();

    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 1,
        event: acpUpdate("agent_message_chunk", {
          content: { type: "text", text: "完成" },
        }),
      }),
    );
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 2,
        event: acpUpdate("agent_message_chunk", {
          content: { type: "text", text: "了" },
        }),
      }),
    );
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 3,
        event: {
          type: "kimi_acp",
          method: "session/prompt/result",
          params: { response: { stopReason: "end_turn" } },
        },
      }),
    );

    await vi.waitFor(() => expect(relay.raw).toHaveLength(1));
    expect(relay.envelopes.map((envelope) => MessageEnvelopeSchema.parse(envelope))).toEqual([
      expect.objectContaining({
        type: "assistant_message",
        seq: 1,
        payload: expect.objectContaining({ revision: 1, text: "完成", status: "streaming" }),
      }),
      expect.objectContaining({
        type: "assistant_message",
        seq: 2,
        payload: expect.objectContaining({ revision: 2, text: "完成了", status: "streaming" }),
      }),
      expect.objectContaining({
        type: "assistant_message",
        seq: 3,
        payload: expect.objectContaining({ revision: 3, text: "完成了", status: "completed" }),
      }),
    ]);
    expect(RelayControlSchema.parse(JSON.parse(relay.raw[0]))).toMatchObject({
      type: "turn_result",
      sessionId: "s1",
      success: true,
      isError: false,
    });
    expect(onTurnResult).toHaveBeenCalledWith("s1");
  });

  it("marks each queued Kimi prompt working when ACP actually starts it", async () => {
    const { onTurnStart, onTurnResult } = await createConnectedRegistry();

    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 4,
        event: {
          type: "kimi_acp",
          method: "session/prompt/result",
          params: { response: { stopReason: "end_turn" } },
        },
      }),
    );
    acceptedSocket?.write(serializeWorkerMsg({ type: "worker_turn_started" }));

    await vi.waitFor(() => expect(onTurnStart).toHaveBeenCalledWith("s1"));
    expect(onTurnResult).toHaveBeenCalledWith("s1");
    expect(onTurnResult.mock.invocationCallOrder[0]).toBeLessThan(
      onTurnStart.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("forwards Kimi tool lifecycle updates and thought chunks", async () => {
    const { relay } = await createConnectedRegistry();

    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 4,
        event: acpUpdate("agent_thought_chunk", {
          content: { type: "text", text: "检查文件" },
        }),
      }),
    );
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 5,
        event: acpUpdate("tool_call", {
          toolCallId: "call-1",
          title: "Run pwd",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "pwd" },
        }),
      }),
    );
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 6,
        event: acpUpdate("tool_call_update", {
          toolCallId: "call-1",
          status: "completed",
          rawOutput: "/tmp/project\n",
        }),
      }),
    );

    await vi.waitFor(() => expect(relay.envelopes).toHaveLength(3));
    expect(relay.envelopes).toEqual([
      expect.objectContaining({ type: "thinking", payload: { text: "检查文件" } }),
      expect.objectContaining({
        type: "assistant_tool_use",
        payload: expect.objectContaining({
          toolName: "Bash",
          toolId: "call-1",
          parameters: expect.objectContaining({ command: "pwd", title: "Run pwd" }),
        }),
      }),
      expect.objectContaining({
        type: "tool_result",
        payload: { toolId: "call-1", result: "/tmp/project\n", isError: false },
      }),
    ]);
  });

  it("forwards dynamic permission options and returns the exact selected option", async () => {
    const { relay, permissionBroker, onApprovalRequested } = await createConnectedRegistry();
    const options = [
      { optionId: "answer-a", name: "A", kind: "allow_once" as const },
      { optionId: "skip", name: "Skip", kind: "reject_once" as const },
    ];

    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_approval_request",
        requestId: "approval-1",
        toolName: "AskUserQuestion",
        input: { question: "Choose one" },
        options,
      }),
    );

    await vi.waitFor(() => expect(relay.envelopes).toHaveLength(1));
    expect(MessageEnvelopeSchema.parse(relay.envelopes[0])).toMatchObject({
      type: "tool_use_request",
      sessionId: "s1",
      payload: {
        toolName: "AskUserQuestion",
        toolId: "approval-1",
        parameters: { question: "Choose one" },
        options,
      },
    });
    expect(permissionBroker.get("approval-1")).toMatchObject({
      provider: "kimi",
      options,
    });
    expect(onApprovalRequested).toHaveBeenCalledWith("s1");

    const response = new Promise<string>((resolve) => {
      acceptedSocket?.once("data", (chunk) => resolve(chunk.toString()));
    });
    expect(
      permissionBroker.resolve("approval-1", {
        behavior: "allow",
        optionId: "answer-a",
      }),
    ).toBe(true);
    expect(WorkerMessageSchema.parse(JSON.parse((await response).trim()))).toEqual({
      type: "worker_approval_response",
      requestId: "approval-1",
      behavior: "allow",
      optionId: "answer-a",
    });
  });

  it("maps available commands and captures the native Kimi session id", async () => {
    const { relay, sessionManager, setProviderCommands } = await createConnectedRegistry();

    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_event",
        seq: 7,
        event: acpUpdate("available_commands_update", {
          availableCommands: [
            {
              name: "compact",
              description: "Compact context",
              input: { hint: "[instructions]" },
            },
          ],
        }),
      }),
    );
    acceptedSocket?.write(
      serializeWorkerMsg({
        type: "worker_native_session_id",
        provider: "kimi",
        sessionId: "kimi-native-1",
      }),
    );

    await vi.waitFor(() => expect(relay.raw).toHaveLength(1));
    expect(RelayControlSchema.parse(JSON.parse(relay.raw[0]))).toEqual({
      type: "command_list_push",
      sessionId: "s1",
      commands: [
        {
          name: "/compact",
          description: "Compact context",
          argumentHint: "[instructions]",
          source: "kimi",
        },
      ],
    });
    expect(setProviderCommands).toHaveBeenCalledWith("s1", [
      {
        name: "/compact",
        description: "Compact context",
        argumentHint: "[instructions]",
        source: "kimi",
      },
    ]);
    await vi.waitFor(() =>
      expect(sessionManager.setHistorySessionId).toHaveBeenCalledWith("s1", "kimi-native-1"),
    );
  });
});
