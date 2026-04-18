// chat-store per-session slice map 单测, 覆盖会话独立性 + CustomEvent 桥接替换
import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore, EMPTY_SLICE } from "./chat-store";

describe("chat-store per-session", () => {
  beforeEach(() => {
    useChatStore.getState().clearAllSessions();
  });

  it("initial state is empty object", () => {
    expect(useChatStore.getState().bySessionId).toEqual({});
  });

  it("appendAssistantText creates a slice for new session", () => {
    useChatStore.getState().appendAssistantText("s1", "hello");
    const slice = useChatStore.getState().bySessionId["s1"];
    expect(slice).toBeDefined();
    expect(slice.messages.length).toBe(1);
    expect(slice.messages[0].text).toBe("hello");
    expect(useChatStore.getState().bySessionId["s2"]).toBeUndefined();
  });

  it("two sessions maintain independent state", () => {
    useChatStore.getState().appendAssistantText("s1", "A");
    useChatStore.getState().appendAssistantText("s2", "B");
    expect(useChatStore.getState().bySessionId["s1"].messages[0].text).toBe("A");
    expect(useChatStore.getState().bySessionId["s2"].messages[0].text).toBe("B");
  });

  it("streaming appends to last partial assistant message of same session", () => {
    useChatStore.getState().appendAssistantText("s1", "hel");
    useChatStore.getState().appendAssistantText("s1", "lo");
    const slice = useChatStore.getState().bySessionId["s1"];
    expect(slice.messages.length).toBe(1);
    expect(slice.messages[0].text).toBe("hello");
  });

  it("markTurnComplete flips isPartial false on last message of given session only", () => {
    useChatStore.getState().appendAssistantText("s1", "done?");
    useChatStore.getState().appendAssistantText("s2", "still going");
    useChatStore.getState().markTurnComplete("s1");
    expect(useChatStore.getState().bySessionId["s1"].messages[0].isPartial).toBe(false);
    expect(useChatStore.getState().bySessionId["s2"].messages[0].isPartial).toBe(true);
  });

  it("addApprovalRequest + updateApprovalStatus scoped by session", () => {
    useChatStore.getState().addApprovalRequest("s1", {
      requestId: "r1",
      toolName: "Bash",
      input: {},
      status: "pending",
    });
    useChatStore.getState().addApprovalRequest("s2", {
      requestId: "r2",
      toolName: "Read",
      input: {},
      status: "pending",
    });
    useChatStore.getState().updateApprovalStatus("s1", "r1", "approved");
    expect(useChatStore.getState().bySessionId["s1"].pendingApprovals[0].status).toBe("approved");
    expect(useChatStore.getState().bySessionId["s2"].pendingApprovals[0].status).toBe("pending");
  });

  it("clearSession removes only one slice", () => {
    useChatStore.getState().appendAssistantText("s1", "x");
    useChatStore.getState().appendAssistantText("s2", "y");
    useChatStore.getState().clearSession("s1");
    expect(useChatStore.getState().bySessionId["s1"]).toBeUndefined();
    expect(useChatStore.getState().bySessionId["s2"]).toBeDefined();
  });

  it("EMPTY_SLICE constant has expected shape", () => {
    expect(EMPTY_SLICE.messages).toEqual([]);
    expect(EMPTY_SLICE.isWorking).toBe(false);
    expect(EMPTY_SLICE.pendingApprovals).toEqual([]);
    expect(EMPTY_SLICE.inputDraft).toBe("");
    expect(EMPTY_SLICE.inputHistoryCursor).toBe(-1);
  });

  it("setInputDraft + moveInputHistoryCursor scoped by session", () => {
    useChatStore.getState().addUserMessage("s1", {
      id: "u1",
      role: "user",
      text: "first",
      isPartial: false,
      timestamp: 0,
      toolCalls: [],
    });
    useChatStore.getState().addUserMessage("s1", {
      id: "u2",
      role: "user",
      text: "second",
      isPartial: false,
      timestamp: 0,
      toolCalls: [],
    });
    useChatStore.getState().setInputDraft("s1", "draft1");
    useChatStore.getState().setInputDraft("s2", "draft2");
    expect(useChatStore.getState().bySessionId["s1"].inputDraft).toBe("draft1");
    expect(useChatStore.getState().bySessionId["s2"].inputDraft).toBe("draft2");

    // cursor 从 -1 起, +1 → 0 (最新一条), +1 → 1 (上一条), clamp 在 historyLen-1
    useChatStore.getState().moveInputHistoryCursor("s1", +1);
    expect(useChatStore.getState().bySessionId["s1"].inputHistoryCursor).toBe(0);
    useChatStore.getState().moveInputHistoryCursor("s1", +1);
    expect(useChatStore.getState().bySessionId["s1"].inputHistoryCursor).toBe(1);
    useChatStore.getState().moveInputHistoryCursor("s1", +5);
    expect(useChatStore.getState().bySessionId["s1"].inputHistoryCursor).toBe(1);

    // s2 无 user message, historyLen=0, clamp 到 -1
    useChatStore.getState().moveInputHistoryCursor("s2", +1);
    expect(useChatStore.getState().bySessionId["s2"].inputHistoryCursor).toBe(-1);

    useChatStore.getState().resetInputHistoryCursor("s1");
    expect(useChatStore.getState().bySessionId["s1"].inputHistoryCursor).toBe(-1);
  });

  it("setQuotedMessage scoped by session", () => {
    useChatStore.getState().setQuotedMessage("s1", { from: "assistant", text: "q1" });
    expect(useChatStore.getState().bySessionId["s1"].quotedMessage?.text).toBe("q1");
    expect(useChatStore.getState().bySessionId["s2"]).toBeUndefined();
    useChatStore.getState().setQuotedMessage("s1", null);
    expect(useChatStore.getState().bySessionId["s1"].quotedMessage).toBeNull();
  });

  it("addToolCall + updateToolResult scoped to message within session", () => {
    useChatStore.getState().appendAssistantText("s1", "streaming");
    const msgId = useChatStore.getState().bySessionId["s1"].messages[0].id;
    useChatStore.getState().addToolCall("s1", msgId, {
      toolName: "Bash",
      input: { cmd: "ls" },
      collapsed: false,
    });
    useChatStore.getState().updateToolResult("s1", msgId, 0, "file1\nfile2");
    const tool = useChatStore.getState().bySessionId["s1"].messages[0].toolCalls[0];
    expect(tool.toolName).toBe("Bash");
    expect(tool.output).toBe("file1\nfile2");
  });

  it("clearAllSessions wipes every slice", () => {
    useChatStore.getState().appendAssistantText("s1", "x");
    useChatStore.getState().appendAssistantText("s2", "y");
    useChatStore.getState().clearAllSessions();
    expect(useChatStore.getState().bySessionId).toEqual({});
  });
});
