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

  it("addApprovalRequest dedupes by requestId (proxy worker may replay pending on reconnect)", () => {
    useChatStore.getState().addApprovalRequest("s1", {
      requestId: "r-dupe",
      toolName: "Write",
      input: { file_path: "/tmp/x" },
      status: "pending",
    });
    // 同一 requestId 第二次 add，应被静默吞掉而不是追加
    useChatStore.getState().addApprovalRequest("s1", {
      requestId: "r-dupe",
      toolName: "Write",
      input: { file_path: "/tmp/x" },
      status: "pending",
    });
    expect(useChatStore.getState().bySessionId["s1"].pendingApprovals).toHaveLength(1);
    // 状态已变 approved 后再 replay 也不应把 status 倒退回 pending
    useChatStore.getState().updateApprovalStatus("s1", "r-dupe", "approved");
    useChatStore.getState().addApprovalRequest("s1", {
      requestId: "r-dupe",
      toolName: "Write",
      input: { file_path: "/tmp/x" },
      status: "pending",
    });
    expect(useChatStore.getState().bySessionId["s1"].pendingApprovals[0].status).toBe("approved");
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
    expect(EMPTY_SLICE.pendingApprovals).toEqual([]);
    expect(EMPTY_SLICE.inputDraft).toBe("");
    expect(EMPTY_SLICE.inputHistoryCursor).toBe(-1);
  });

  it("setInputDraft + setInputHistoryCursor scoped by session", () => {
    useChatStore.getState().setInputDraft("s1", "draft1");
    useChatStore.getState().setInputDraft("s2", "draft2");
    expect(useChatStore.getState().bySessionId["s1"].inputDraft).toBe("draft1");
    expect(useChatStore.getState().bySessionId["s2"].inputDraft).toBe("draft2");

    // setInputHistoryCursor 设绝对值, clamp 由调用方 (InputBar) 基于 localStorage 历史长度负责
    useChatStore.getState().setInputHistoryCursor("s1", 0);
    expect(useChatStore.getState().bySessionId["s1"].inputHistoryCursor).toBe(0);
    useChatStore.getState().setInputHistoryCursor("s1", 1);
    expect(useChatStore.getState().bySessionId["s1"].inputHistoryCursor).toBe(1);

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
