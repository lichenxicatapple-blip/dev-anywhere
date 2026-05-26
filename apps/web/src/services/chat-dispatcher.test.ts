import { beforeEach, describe, expect, it, vi } from "vitest";

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/components/toast", () => ({
  toast: {
    loading: vi.fn(),
    success: toastSuccess,
    error: toastError,
  },
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: null,
  wsManagerRef: null,
}));

import { createChatMessageHandler } from "./chat-dispatcher";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
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
    useSessionStore.setState({ sessions: [] });
    toastSuccess.mockReset();
    toastError.mockReset();
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

  it("replaces stale local approvals with the pending queue replayed after refresh", () => {
    const sendControl = vi.fn();
    const handle = createChatMessageHandler({ sendControl });

    handle(envelope({ payload: { toolId: "req-1", toolName: "Bash", parameters: {} } }));
    handle(envelope({ payload: { toolId: "req-2", toolName: "Read", parameters: {} } }));
    handle(envelope({ payload: { toolId: "req-3", toolName: "Write", parameters: {} } }));
    handle({
      type: "permission_decision_result",
      sessionId: "s1",
      requestId: "req-1",
      outcome: "allow",
      delivered: true,
    } as RelayControlMessage);

    handle({
      type: "pending_approvals_push",
      sessionId: "s1",
      approvals: [
        { requestId: "req-2", toolName: "Read", input: { file_path: "/tmp/a" } },
        { requestId: "req-3", toolName: "Write", input: { file_path: "/tmp/b" } },
      ],
    } as RelayControlMessage);

    expect(useChatStore.getState().bySessionId.s1.pendingApprovals).toEqual([
      {
        requestId: "req-2",
        toolName: "Read",
        input: { file_path: "/tmp/a" },
        status: "pending",
      },
      {
        requestId: "req-3",
        toolName: "Write",
        input: { file_path: "/tmp/b" },
        status: "pending",
      },
    ]);
    expect(sendControl).toHaveBeenCalledWith({
      type: "permission_request_delivered",
      sessionId: "s1",
      requestId: "req-2",
    });
    expect(sendControl).toHaveBeenCalledWith({
      type: "permission_request_delivered",
      sessionId: "s1",
      requestId: "req-3",
    });
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

  it("flushes the queued user input batch as one prompt after a JSON turn completes", () => {
    const relay = { sendControl: vi.fn(), sendEnvelope: vi.fn() };
    const handler = createChatMessageHandler(relay);
    useChatStore.setState({
      bySessionId: {
        s1: {
          ...EMPTY_SLICE,
          messages: [
            {
              id: "queued-1",
              role: "user",
              text: "first queued",
              isPartial: false,
              timestamp: 1,
              toolCalls: [],
              deliveryStatus: "queued",
            },
            {
              id: "queued-2",
              role: "user",
              text: "second queued",
              isPartial: false,
              timestamp: 2,
              toolCalls: [],
              deliveryStatus: "queued",
            },
          ],
        },
      },
    });
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", state: "idle", provider: "claude", mode: "json" }],
    });

    handler({
      type: "turn_result",
      sessionId: "s1",
      success: true,
      isError: false,
      result: "",
    });

    expect(relay.sendEnvelope).toHaveBeenCalledTimes(1);
    expect(relay.sendEnvelope).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user_input",
        sessionId: "s1",
        payload: { text: "first queued\n\nsecond queued", messageId: "queued-1" },
      }),
    );
    expect(useChatStore.getState().bySessionId.s1.messages[0].deliveryStatus).toBeUndefined();
    expect(useChatStore.getState().bySessionId.s1.messages[1].deliveryStatus).toBeUndefined();
    expect(useSessionStore.getState().sessions.find((s) => s.sessionId === "s1")?.state).toBe(
      "working",
    );
  });

  it("turns native assistant tool use into an activity bubble boundary", () => {
    const handle = createChatMessageHandler({ sendControl: vi.fn() });

    handle(
      envelope({
        type: "assistant_message",
        payload: { text: "我先跑一下测试。", isPartial: true },
      }),
    );
    handle(
      envelope({
        type: "assistant_tool_use",
        payload: {
          toolId: "tool-1",
          toolName: "Bash",
          parameters: { command: "pnpm test -- --token=abc123" },
        },
      }),
    );
    handle(
      envelope({
        type: "assistant_message",
        payload: { text: "测试跑完了。", isPartial: true },
      }),
    );

    const messages = useChatStore.getState().bySessionId.s1.messages;
    expect(messages.map((m) => m.role)).toEqual(["assistant", "activity", "assistant"]);
    expect(messages[0]).toMatchObject({ text: "我先跑一下测试。", isPartial: false });
    expect(messages[1]).toMatchObject({
      role: "activity",
      activity: {
        id: "tool-1",
        source: "claude-native",
        kind: "tool",
        status: "running",
        toolName: "Bash",
      },
    });
    expect(messages[1].text).toContain("运行命令");
    expect(messages[1].text).not.toContain("abc123");
    expect(messages[2]).toMatchObject({ text: "测试跑完了。", isPartial: true });
  });

  it("keeps native permission requests in the approval queue without duplicate activity bubbles", () => {
    const sendControl = vi.fn();
    const handle = createChatMessageHandler({ sendControl });

    handle(
      envelope({
        type: "tool_use_request",
        payload: {
          toolId: "req-approval",
          toolName: "Write",
          parameters: { file_path: "/tmp/output.txt", content: "secret=123" },
        },
      }),
    );

    const messages = useChatStore.getState().bySessionId.s1.messages;
    expect(messages).toHaveLength(0);
    expect(useChatStore.getState().bySessionId.s1.pendingApprovals[0].status).toBe("pending");
    expect(sendControl).toHaveBeenCalledWith({
      type: "permission_request_delivered",
      sessionId: "s1",
      requestId: "req-approval",
    });
  });

  it("replays pending approvals without inserting waiting activity bubbles", () => {
    const sendControl = vi.fn();
    const handle = createChatMessageHandler({ sendControl });

    handle({
      type: "pending_approvals_push",
      sessionId: "s1",
      approvals: [{ requestId: "req-1", toolName: "Grep", input: { pattern: "LLMClient" } }],
    } as RelayControlMessage);

    const slice = useChatStore.getState().bySessionId.s1;
    expect(slice.messages).toHaveLength(0);
    expect(slice.pendingApprovals).toEqual([
      {
        requestId: "req-1",
        toolName: "Grep",
        input: { pattern: "LLMClient" },
        status: "pending",
      },
    ]);
    expect(sendControl).toHaveBeenCalledWith({
      type: "permission_request_delivered",
      sessionId: "s1",
      requestId: "req-1",
    });
  });

  it("marks native tool activity terminal when tool_result arrives", () => {
    const handle = createChatMessageHandler({ sendControl: vi.fn() });

    handle(
      envelope({
        type: "assistant_tool_use",
        payload: {
          toolId: "tool-1",
          toolName: "Read",
          parameters: { file_path: "/tmp/input.txt" },
        },
      }),
    );
    handle(
      envelope({
        type: "tool_result",
        payload: { toolId: "tool-1", result: "ok", isError: false },
      }),
    );

    const message = useChatStore.getState().bySessionId.s1.messages[0];
    expect(message.activity?.status).toBe("done");
    expect(message.isPartial).toBe(false);
  });

  it("shows a completion toast for compact turn_result while the session is compacting", () => {
    const handle = createChatMessageHandler({ sendControl: vi.fn() });
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "compacting" }],
    });

    handle({
      type: "turn_result",
      sessionId: "s1",
      success: true,
      isError: false,
      result: "上下文压缩完成。",
    } as RelayControlMessage);

    expect(toastSuccess).toHaveBeenCalledWith("上下文压缩完成", { id: "compact-s1" });
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast when compact turn_result fails", () => {
    const handle = createChatMessageHandler({ sendControl: vi.fn() });
    useSessionStore.setState({
      sessions: [{ sessionId: "s1", mode: "json", provider: "claude", state: "compacting" }],
    });

    handle({
      type: "turn_result",
      sessionId: "s1",
      success: false,
      isError: true,
      result: "上下文压缩失败：No messages to compact",
    } as RelayControlMessage);

    expect(toastError).toHaveBeenCalledWith("上下文压缩失败：No messages to compact", {
      id: "compact-s1",
    });
    expect(toastSuccess).not.toHaveBeenCalled();
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
