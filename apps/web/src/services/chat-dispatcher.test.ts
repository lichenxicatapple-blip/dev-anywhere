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

  it("uses turn_result.result as JSON fallback when no assistant message arrived", () => {
    const handle = createChatMessageHandler({ sendControl: vi.fn() });

    handle({
      type: "turn_result",
      sessionId: "s1",
      success: true,
      isError: false,
      result: "OK",
    } as RelayControlMessage);

    const messages = useChatStore.getState().bySessionId.s1.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "OK",
      isPartial: false,
    });
  });

  it("loads session history messages into chat store", () => {
    const handle = createChatMessageHandler({ sendControl: vi.fn() });

    handle({
      type: "session_history_messages",
      sessionId: "s1",
      messages: [
        { role: "user", text: "历史问题", timestamp: 100, cursor: "b:100" },
        { role: "assistant", text: "历史回复", timestamp: 200, cursor: "b:200" },
      ],
    } as RelayControlMessage);

    const messages = useChatStore.getState().bySessionId.s1.messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: "history-s1-b:100",
      role: "user",
      text: "历史问题",
      timestamp: 100,
    });
    expect(messages[1]).toMatchObject({
      id: "history-s1-b:200",
      role: "assistant",
      text: "历史回复",
      timestamp: 200,
    });
  });

  it("does not duplicate turn_result.result after streamed assistant text", () => {
    const handle = createChatMessageHandler({ sendControl: vi.fn() });

    handle(
      envelope({
        type: "assistant_message",
        payload: { text: "OK", isPartial: true },
      }),
    );
    handle({
      type: "turn_result",
      sessionId: "s1",
      success: true,
      isError: false,
      result: "OK",
    } as RelayControlMessage);

    const messages = useChatStore.getState().bySessionId.s1.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "assistant",
      text: "OK",
      isPartial: false,
    });
  });

  it("renders accepted user_input envelopes idempotently across clients", () => {
    const handle = createChatMessageHandler({ sendControl: vi.fn() });
    const acceptedInput = envelope({
      type: "user_input",
      sessionId: "s1",
      timestamp: 1234,
      source: "proxy",
      payload: { text: "hello from phone", messageId: "s1-user-client-1" },
    });

    handle(acceptedInput);
    handle(acceptedInput);

    const messages = useChatStore.getState().bySessionId.s1.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "s1-user-client-1",
      role: "user",
      text: "hello from phone",
      isPartial: false,
      timestamp: 1234,
    });
  });
});
