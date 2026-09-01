import { describe, expect, it } from "vitest";
import { MessageEnvelopeSchema, RelayControlSchema } from "@dev-anywhere/shared";
import { KimiAcpEventMapper } from "#src/serve/kimi-acp-event-mapper.js";

function update(sessionUpdate: string, fields: Record<string, unknown>) {
  return {
    type: "kimi_acp",
    method: "session/update",
    params: { sessionId: "kimi-session-1", update: { sessionUpdate, ...fields } },
  };
}

describe("KimiAcpEventMapper", () => {
  it("maps agent message chunks to assistant text snapshots", () => {
    const mapper = new KimiAcpEventMapper();

    expect(
      mapper.map(
        "s1",
        1,
        update("agent_message_chunk", { content: { type: "text", text: "你好" } }),
      ),
    ).toEqual([{ kind: "assistant_text", text: "你好" }]);
  });

  it("maps thought chunks to schema-valid thinking envelopes", () => {
    const mapper = new KimiAcpEventMapper();
    const mapped = mapper.map(
      "s1",
      2,
      update("agent_thought_chunk", { content: { type: "text", text: "分析中" } }),
    );

    expect(mapped).toHaveLength(1);
    const first = mapped[0];
    expect(first?.kind).toBe("envelope");
    if (first?.kind !== "envelope") throw new Error("expected envelope");
    expect(MessageEnvelopeSchema.parse(first.envelope)).toMatchObject({
      type: "thinking",
      sessionId: "s1",
      seq: 2,
      payload: { text: "分析中" },
    });
  });

  it("merges partial tool_call_update fields and emits the terminal result", () => {
    const mapper = new KimiAcpEventMapper();
    const started = mapper.map(
      "s1",
      3,
      update("tool_call", {
        toolCallId: "tool-1",
        title: "Run pwd",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "pwd", cwd: "/tmp/project" },
      }),
    );
    const completed = mapper.map(
      "s1",
      4,
      update("tool_call_update", {
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { stdout: "/tmp/project\n", exitCode: 0 },
      }),
    );

    expect(started).toHaveLength(1);
    const toolUse = started[0];
    expect(toolUse?.kind).toBe("envelope");
    if (toolUse?.kind !== "envelope") throw new Error("expected envelope");
    expect(MessageEnvelopeSchema.parse(toolUse.envelope)).toMatchObject({
      type: "assistant_tool_use",
      sessionId: "s1",
      payload: {
        toolName: "Bash",
        toolId: "tool-1",
        parameters: {
          command: "pwd",
          cwd: "/tmp/project",
          title: "Run pwd",
          kind: "execute",
        },
      },
    });

    expect(completed).toHaveLength(1);
    const result = completed[0];
    expect(result?.kind).toBe("envelope");
    if (result?.kind !== "envelope") throw new Error("expected envelope");
    expect(MessageEnvelopeSchema.parse(result.envelope)).toMatchObject({
      type: "tool_result",
      sessionId: "s1",
      seq: 4,
      payload: {
        toolId: "tool-1",
        result: { stdout: "/tmp/project\n", exitCode: 0 },
        isError: false,
      },
    });

    expect(
      mapper.map(
        "s1",
        5,
        update("tool_call_update", {
          toolCallId: "tool-1",
          status: "completed",
          rawOutput: { stdout: "/tmp/project\n", exitCode: 0 },
        }),
      ),
    ).toEqual([]);
  });

  it("maps failed tool updates to error results", () => {
    const mapper = new KimiAcpEventMapper();
    mapper.map(
      "s1",
      5,
      update("tool_call", {
        toolCallId: "tool-failed",
        title: "Read missing file",
        kind: "read",
        status: "pending",
      }),
    );

    const mapped = mapper.map(
      "s1",
      6,
      update("tool_call_update", {
        toolCallId: "tool-failed",
        status: "failed",
        content: [{ type: "content", content: { type: "text", text: "not found" } }],
      }),
    );

    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({
      kind: "envelope",
      envelope: {
        type: "tool_result",
        payload: { toolId: "tool-failed", isError: true },
      },
    });
  });

  it("bounds completed tool tombstones while suppressing recent duplicate terminal updates", () => {
    const mapper = new KimiAcpEventMapper();
    for (let index = 0; index < 513; index += 1) {
      const toolCallId = `tool-${index}`;
      mapper.map(
        "s1",
        index * 2,
        update("tool_call", { toolCallId, kind: "read", status: "in_progress" }),
      );
      expect(
        mapper.map(
          "s1",
          index * 2 + 1,
          update("tool_call_update", {
            toolCallId,
            status: "completed",
            rawOutput: `result-${index}`,
          }),
        ),
      ).toHaveLength(1);
    }

    expect(
      mapper.map(
        "s1",
        2_000,
        update("tool_call_update", {
          toolCallId: "tool-512",
          status: "completed",
          rawOutput: "result-512",
        }),
      ),
    ).toEqual([]);
    // The oldest tombstone is evicted after the bounded set reaches 513 entries.
    expect(
      mapper.map(
        "s1",
        2_001,
        update("tool_call_update", {
          toolCallId: "tool-0",
          status: "completed",
          rawOutput: "result-0",
        }),
      ),
    ).toHaveLength(2);
  });

  it("drops incomplete tool payloads when a turn ends", () => {
    const mapper = new KimiAcpEventMapper();
    mapper.map(
      "s1",
      1,
      update("tool_call", {
        toolCallId: "unfinished",
        kind: "execute",
        status: "in_progress",
        rawInput: { command: "long-running" },
      }),
    );
    mapper.map("s1", 2, {
      type: "kimi_acp",
      method: "session/prompt/error",
      params: { message: "turn ended" },
    });

    const lateTerminal = mapper.map(
      "s1",
      3,
      update("tool_call_update", {
        toolCallId: "unfinished",
        status: "completed",
        rawOutput: "late",
      }),
    );
    expect(lateTerminal).toHaveLength(2);
    expect(lateTerminal[0]).toMatchObject({
      kind: "envelope",
      envelope: { type: "assistant_tool_use", payload: { parameters: {} } },
    });
  });

  it("maps prompt completion and errors to turn_result controls", () => {
    const mapper = new KimiAcpEventMapper();
    const completed = mapper.map("s1", 7, {
      type: "kimi_acp",
      method: "session/prompt/result",
      params: { response: { stopReason: "end_turn" } },
    });
    const failed = mapper.map("s1", 8, {
      type: "kimi_acp",
      method: "session/prompt/error",
      params: { message: "upstream unavailable" },
    });

    expect(completed).toHaveLength(1);
    expect(failed).toHaveLength(1);
    for (const [mapped, expected] of [
      [completed[0], { success: true, isError: false }],
      [failed[0], { success: false, isError: true, result: "upstream unavailable" }],
    ] as const) {
      expect(mapped?.kind).toBe("control");
      if (mapped?.kind !== "control") throw new Error("expected control");
      expect(RelayControlSchema.parse(JSON.parse(mapped.raw))).toMatchObject({
        type: "turn_result",
        sessionId: "s1",
        ...expected,
      });
      expect(mapped.notifyTurnResult).toBe(true);
    }
  });

  it.each(["cancelled", "max_tokens", "max_turn_requests", "refusal", "future_reason"])(
    "maps non-success stop reason %s to a failed turn",
    (stopReason) => {
      const mapper = new KimiAcpEventMapper();
      const mapped = mapper.map("s1", 9, {
        type: "kimi_acp",
        method: "session/prompt/result",
        params: { response: { stopReason } },
      });

      expect(mapped).toHaveLength(1);
      const first = mapped[0];
      expect(first?.kind).toBe("control");
      if (first?.kind !== "control") throw new Error("expected control");
      expect(RelayControlSchema.parse(JSON.parse(first.raw))).toMatchObject({
        type: "turn_result",
        sessionId: "s1",
        success: false,
        isError: true,
        result: `Kimi ACP stopped: ${stopReason}`,
      });
    },
  );

  it("treats a missing stop reason as a failed turn", () => {
    const mapper = new KimiAcpEventMapper();
    const [mapped] = mapper.map("s1", 9, {
      type: "kimi_acp",
      method: "session/prompt/result",
      params: { response: {} },
    });

    expect(mapped?.kind).toBe("control");
    if (mapped?.kind !== "control") throw new Error("expected control");
    expect(RelayControlSchema.parse(JSON.parse(mapped.raw))).toMatchObject({
      success: false,
      isError: true,
      result: "Kimi ACP stopped: unknown",
    });
  });

  it("maps available ACP commands to the existing slash-command control", () => {
    const mapper = new KimiAcpEventMapper();
    const mapped = mapper.map(
      "s1",
      9,
      update("available_commands_update", {
        availableCommands: [
          {
            name: "compact",
            description: "Compact conversation context",
            input: { hint: "[instructions]" },
          },
          { name: "/help", description: "Show help", input: null },
        ],
      }),
    );

    expect(mapped).toHaveLength(1);
    const first = mapped[0];
    expect(first?.kind).toBe("control");
    if (first?.kind !== "control") throw new Error("expected control");
    expect(RelayControlSchema.parse(JSON.parse(first.raw))).toEqual({
      type: "command_list_push",
      sessionId: "s1",
      commands: [
        {
          name: "/compact",
          description: "Compact conversation context",
          argumentHint: "[instructions]",
          source: "kimi",
        },
        { name: "/help", description: "Show help", source: "kimi" },
      ],
    });
    expect(first.completeAssistant).toBe(false);
  });

  it("ignores ACP user-message echoes because relay input and disk history are authoritative", () => {
    const mapper = new KimiAcpEventMapper();
    expect(
      mapper.map(
        "s1",
        10,
        update("user_message_chunk", { content: { type: "text", text: "live echo" } }),
      ),
    ).toEqual([]);
  });

  it("ignores known non-chat updates and exposes unknown variants as a canary", () => {
    const mapper = new KimiAcpEventMapper();

    expect(mapper.map("s1", 14, update("usage_update", { used: 1 }))).toEqual([]);
    expect(mapper.map("s1", 15, update("future_update", {}))).toEqual([
      { kind: "unknown_update", updateType: "future_update" },
    ]);
  });
});
