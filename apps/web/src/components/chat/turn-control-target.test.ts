import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/stores/chat-store";
import { getTurnControlTarget } from "./turn-control-target";

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    text: "",
    isPartial: false,
    timestamp: 0,
    toolCalls: [],
    ...overrides,
  };
}

describe("getTurnControlTarget", () => {
  it("clears stop controls when the turn is not working", () => {
    expect(
      getTurnControlTarget({
        messages: [
          message({
            id: "activity-old",
            role: "activity",
            isPartial: true,
            activity: {
              id: "tool-1",
              source: "claude-native",
              kind: "tool",
              status: "running",
              text: "运行命令",
              durable: false,
            },
          }),
        ],
        isWorking: false,
        hasPendingApprovals: false,
      }),
    ).toEqual({ messageId: null, showThinking: false });
  });

  it("hides stop controls while approval cards own the active decision", () => {
    expect(
      getTurnControlTarget({
        messages: [message({ id: "assistant-partial", isPartial: true })],
        isWorking: true,
        hasPendingApprovals: true,
      }),
    ).toEqual({ messageId: null, showThinking: false });
  });

  it("moves the control to the latest running activity", () => {
    const activity = (id: string, status: "running" | "done"): ChatMessage =>
      message({
        id,
        role: "activity",
        isPartial: status === "running",
        activity: {
          id,
          source: "claude-native",
          kind: "tool",
          status,
          text: id,
          durable: false,
        },
      });

    expect(
      getTurnControlTarget({
        messages: [activity("activity-1", "running"), activity("activity-2", "running")],
        isWorking: true,
        hasPendingApprovals: false,
      }),
    ).toEqual({ messageId: "activity-2", showThinking: false });

    expect(
      getTurnControlTarget({
        messages: [activity("activity-1", "done"), activity("activity-2", "running")],
        isWorking: true,
        hasPendingApprovals: false,
      }),
    ).toEqual({ messageId: "activity-2", showThinking: false });
  });

  it("uses the active assistant bubble during pure text streaming", () => {
    expect(
      getTurnControlTarget({
        messages: [message({ id: "assistant-partial", role: "assistant", isPartial: true })],
        isWorking: true,
        hasPendingApprovals: false,
      }),
    ).toEqual({ messageId: "assistant-partial", showThinking: false });
  });

  it("falls back to thinking only when no active message surface exists", () => {
    expect(
      getTurnControlTarget({
        messages: [],
        isWorking: true,
        hasPendingApprovals: false,
      }),
    ).toEqual({ messageId: null, showThinking: true });
  });
});
