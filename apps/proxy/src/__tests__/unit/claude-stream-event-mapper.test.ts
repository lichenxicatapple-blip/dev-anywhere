import { describe, expect, it } from "vitest";
import { RelayControlSchema } from "@dev-anywhere/shared";
import { mapClaudeStreamEvent } from "#src/serve/claude-stream-event-mapper.js";

describe("mapClaudeStreamEvent", () => {
  it("maps assistant text blocks when stream deltas are disabled", () => {
    const mapped = mapClaudeStreamEvent("s1", 21, {
      event: {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      isStreamDeltaSession: false,
      isCompactingSession: false,
    });

    expect(mapped).toEqual([
      {
        kind: "envelope",
        envelope: expect.objectContaining({
          type: "assistant_message",
          sessionId: "s1",
          seq: 21,
          payload: { text: "hello", isPartial: true },
        }),
      },
    ]);
  });

  it("does not repeat aggregated text when stream deltas are enabled", () => {
    const mapped = mapClaudeStreamEvent("s1", 22, {
      event: {
        type: "assistant",
        message: { content: [{ type: "text", text: "hello" }] },
      },
      isStreamDeltaSession: true,
      isCompactingSession: false,
    });

    expect(mapped).toEqual([]);
  });

  it("maps result events to turn_result controls", () => {
    const mapped = mapClaudeStreamEvent("s1", 23, {
      event: { type: "result", subtype: "success", is_error: false, result: "done" },
      isStreamDeltaSession: false,
      isCompactingSession: false,
    });

    expect(mapped).toHaveLength(1);
    const first = mapped[0];
    expect(first.kind).toBe("control");
    if (first.kind !== "control") throw new Error("expected control mapping");
    expect(first.notifyTurnResult).toBe(true);
    expect(RelayControlSchema.parse(JSON.parse(first.raw))).toMatchObject({
      type: "turn_result",
      sessionId: "s1",
      success: true,
      isError: false,
      result: "done",
    });
  });

  it("adds compact success control when assistant content arrives during compaction", () => {
    const mapped = mapClaudeStreamEvent("s1", 24, {
      event: {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tool-1", name: "Bash", input: {} }] },
      },
      isStreamDeltaSession: false,
      isCompactingSession: true,
    });

    expect(mapped.map((item) => item.kind)).toEqual(["envelope", "control"]);
    const control = mapped[1];
    expect(control.kind).toBe("control");
    if (control.kind !== "control") throw new Error("expected control mapping");
    expect(RelayControlSchema.parse(JSON.parse(control.raw))).toMatchObject({
      type: "turn_result",
      sessionId: "s1",
      success: true,
      isError: false,
    });
  });
});
