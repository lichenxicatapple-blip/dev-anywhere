// chat-store per-session slice map 单测, 覆盖会话独立性 + CustomEvent 桥接替换
import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "./chat-store";

describe("chat-store per-session", () => {
  beforeEach(() => {
    useChatStore.getState().clearAllSessions();
  });

  it("appendAssistantText creates a slice for new session", () => {
    useChatStore.getState().appendAssistantText("s1", "hello");
    const slice = useChatStore.getState().bySessionId["s1"];
    expect(slice.messages).toHaveLength(1);
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

  it("activity messages split assistant streaming into separate bubbles", () => {
    useChatStore.getState().appendAssistantText("s1", "我先看一下。");
    useChatStore.getState().upsertActivityMessage("s1", {
      id: "tool-1",
      source: "claude-native",
      kind: "tool",
      status: "running",
      text: "运行命令：pnpm test",
      durable: false,
    });
    useChatStore.getState().appendAssistantText("s1", "结果出来了。");

    const messages = useChatStore.getState().bySessionId["s1"].messages;
    expect(messages.map((m) => m.role)).toEqual(["assistant", "activity", "assistant"]);
    expect(messages[0]).toMatchObject({ text: "我先看一下。", isPartial: false });
    expect(messages[1]).toMatchObject({
      role: "activity",
      text: "运行命令：pnpm test",
      activity: {
        id: "tool-1",
        source: "claude-native",
        kind: "tool",
        status: "running",
      },
    });
    expect(messages[2]).toMatchObject({ text: "结果出来了。", isPartial: true });
    expect(new Set(messages.map((m) => m.id)).size).toBe(3);
  });

  it("markTurnComplete flips isPartial false on last message of given session only", () => {
    useChatStore.getState().appendAssistantText("s1", "done?");
    useChatStore.getState().appendAssistantText("s2", "still going");
    useChatStore.getState().markTurnComplete("s1");
    expect(useChatStore.getState().bySessionId["s1"].messages[0].isPartial).toBe(false);
    expect(useChatStore.getState().bySessionId["s2"].messages[0].isPartial).toBe(true);
    expect(useChatStore.getState().bySessionId["s1"].turnCompletionVersion).toBe(1);
    expect(useChatStore.getState().bySessionId["s2"].turnCompletionVersion).toBe(0);
  });

  it("markTurnFailed advances the formal turn completion signal", () => {
    useChatStore.getState().appendAssistantText("s1", "failed");

    useChatStore.getState().markTurnFailed("s1");

    expect(useChatStore.getState().bySessionId.s1.turnCompletionVersion).toBe(1);
  });

  it("completeActivityMessage marks the native activity terminal without touching other sessions", () => {
    useChatStore.getState().upsertActivityMessage("s1", {
      id: "tool-1",
      source: "claude-native",
      kind: "tool",
      status: "running",
      text: "运行命令：pnpm test",
      durable: false,
    });
    useChatStore.getState().upsertActivityMessage("s2", {
      id: "tool-1",
      source: "claude-native",
      kind: "tool",
      status: "running",
      text: "运行命令：pnpm build",
      durable: false,
    });

    useChatStore.getState().completeActivityMessage("s1", "tool-1", "done");

    expect(useChatStore.getState().bySessionId.s1.messages[0].activity?.status).toBe("done");
    expect(useChatStore.getState().bySessionId.s1.messages[0].isPartial).toBe(false);
    expect(useChatStore.getState().bySessionId.s2.messages[0].activity?.status).toBe("running");
  });

  it("markTurnComplete finishes running activity messages", () => {
    useChatStore.getState().upsertActivityMessage("s1", {
      id: "tool-1",
      source: "claude-native",
      kind: "tool",
      status: "running",
      text: "运行命令：pnpm test",
      durable: false,
    });

    useChatStore.getState().markTurnComplete("s1");

    const [tool] = useChatStore.getState().bySessionId.s1.messages;
    expect(tool.activity?.status).toBe("done");
    expect(tool.isPartial).toBe(false);
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
    // s2 不只是"还存在"，内容必须保留
    expect(useChatStore.getState().bySessionId["s2"].messages[0].text).toBe("y");
  });

  it("setInputDraft scoped by session", () => {
    useChatStore.getState().setInputDraft("s1", "draft1");
    useChatStore.getState().setInputDraft("s2", "draft2");
    expect(useChatStore.getState().bySessionId["s1"].inputDraft).toBe("draft1");
    expect(useChatStore.getState().bySessionId["s2"].inputDraft).toBe("draft2");
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

  it("prepends older history pages without duplicating existing or live messages", () => {
    useChatStore.getState().loadHistoryPage("s1", {
      mode: "replace",
      hasMore: true,
      nextBefore: "b:200",
      messages: [
        { role: "user", text: "recent user", cursor: "b:300" },
        { role: "assistant", text: "recent assistant", cursor: "b:400" },
      ],
    });
    useChatStore.getState().addUserMessage("s1", {
      id: "s1-live-1",
      role: "user",
      text: "live",
      isPartial: false,
      timestamp: 500,
      toolCalls: [],
    });

    useChatStore.getState().loadHistoryPage("s1", {
      mode: "prepend",
      hasMore: false,
      messages: [
        { role: "user", text: "oldest", cursor: "b:100" },
        { role: "user", text: "recent user duplicate", cursor: "b:300" },
      ],
    });

    const slice = useChatStore.getState().bySessionId.s1;
    expect(slice.historyHasMore).toBe(false);
    expect(slice.historyNextBefore).toBeNull();
    expect(slice.messages.map((m) => m.text)).toEqual([
      "oldest",
      "recent user",
      "recent assistant",
      "live",
    ]);
  });
});
