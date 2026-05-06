import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: null,
  wsManagerRef: null,
}));

import { createChatMessageHandler } from "./chat-dispatcher";
import { useChatStore } from "@/stores/chat-store";
import type { MessageEnvelope, RelayControlMessage } from "@dev-anywhere/shared";

function envelope(overrides: Partial<MessageEnvelope>): MessageEnvelope {
  return {
    type: "tool_use_request",
    sessionId: "s1",
    seq: 1,
    timestamp: Date.now(),
    source: "proxy",
    version: "1",
    payload: {
      toolId: "req-1",
      toolName: "Bash",
      parameters: { command: "pwd" },
    },
    ...overrides,
  } as MessageEnvelope;
}

describe("chat-dispatcher permission flow", () => {
  beforeEach(() => {
    useChatStore.getState().clearAllSessions();
  });

  it("acks delivered permission requests and waits for proxy decision result", () => {
    const sendControl = vi.fn();
    const handle = createChatMessageHandler({ sendControl });

    handle(envelope({}));

    expect(sendControl).toHaveBeenCalledWith({
      type: "permission_request_delivered",
      sessionId: "s1",
      requestId: "req-1",
    });
    expect(useChatStore.getState().bySessionId.s1.pendingApprovals[0].status).toBe("pending");

    handle({
      type: "permission_decision_result",
      sessionId: "s1",
      requestId: "req-1",
      outcome: "allow",
      delivered: true,
    } as RelayControlMessage);

    expect(useChatStore.getState().bySessionId.s1.pendingApprovals[0].status).toBe("approved");
  });

  it("ignores failed permission decision results", () => {
    const handle = createChatMessageHandler({ sendControl: vi.fn() });
    handle(envelope({}));

    handle({
      type: "permission_decision_result",
      sessionId: "s1",
      requestId: "req-1",
      outcome: "deny",
      delivered: false,
      message: "Permission request is no longer pending.",
    } as RelayControlMessage);

    expect(useChatStore.getState().bySessionId.s1.pendingApprovals[0].status).toBe("pending");
  });
});
