import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionState, type ControlMessage } from "@dev-anywhere/shared";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { RelayHistoryHandlers } from "#src/serve/relay-history-handlers.js";
import { readSessionMessagesPage } from "#src/serve/session-history.js";
import type { SessionInfo } from "#src/serve/session-manager.js";

vi.mock("#src/serve/session-history.js", () => ({
  readSessionMessagesPage: vi.fn(),
}));

const mockedReadSessionMessagesPage = vi.mocked(readSessionMessagesPage);

beforeEach(() => {
  mockedReadSessionMessagesPage.mockReset();
});

describe("RelayHistoryHandlers pending approval replay", () => {
  it("pushes only unresolved pending approvals when a JSON chat reloads", () => {
    const permissionBroker = new PermissionBroker();
    const decisions: unknown[] = [];
    permissionBroker.registerWorkerRequest(
      {
        requestId: "req-1",
        sessionId: "s1",
        provider: "claude",
        toolName: "Bash",
        input: { command: "pwd" },
      },
      (decision) => decisions.push(decision),
    );
    permissionBroker.registerWorkerRequest(
      {
        requestId: "req-2",
        sessionId: "s1",
        provider: "claude",
        toolName: "Read",
        input: { file_path: "/tmp/a" },
      },
      (decision) => decisions.push(decision),
    );
    permissionBroker.registerWorkerRequest(
      {
        requestId: "req-3",
        sessionId: "s1",
        provider: "claude",
        toolName: "Write",
        input: { file_path: "/tmp/b" },
      },
      (decision) => decisions.push(decision),
    );
    expect(permissionBroker.resolve("req-1", { behavior: "allow" })).toBe(true);

    const sent: string[] = [];
    const handlers = new RelayHistoryHandlers({
      relaySend: (data) => sent.push(data),
      sessionManager: { getSession: () => undefined } as never,
      permissionBroker,
    });

    handlers.onSessionMessagesRequest({
      type: "session_messages_request",
      sessionId: "s1",
      requestId: "history-1",
    } as ControlMessage<"session_messages_request">);

    const pendingPush = sent
      .map((raw) => JSON.parse(raw) as { type?: string; approvals?: unknown[] })
      .find((msg) => msg.type === "pending_approvals_push");

    expect(pendingPush?.approvals).toEqual([
      { requestId: "req-2", toolName: "Read", input: { file_path: "/tmp/a" } },
      { requestId: "req-3", toolName: "Write", input: { file_path: "/tmp/b" } },
    ]);
    expect(decisions).toEqual([{ behavior: "allow" }]);
  });
});

describe("RelayHistoryHandlers resumed JSON history", () => {
  it("keeps reading the resumed transcript after Claude reports a new active session id", async () => {
    mockedReadSessionMessagesPage.mockImplementation(async (claudeSessionId) => {
      if (claudeSessionId === "resume-native") {
        return {
          messages: [
            { role: "user", text: "旧问题", cursor: "b:100", timestamp: 100 },
            { role: "assistant", text: "旧回答", cursor: "b:200", timestamp: 200 },
          ],
          hasMore: true,
          nextBefore: "b:100",
        };
      }
      if (claudeSessionId === "active-native") {
        return {
          messages: [{ role: "assistant", text: "新回答", cursor: "b:10", timestamp: 300 }],
          hasMore: false,
        };
      }
      return { messages: [], hasMore: false };
    });

    const sent: string[] = [];
    const session: SessionInfo = {
      id: "s1",
      mode: "json",
      provider: "claude",
      state: SessionState.IDLE,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/tmp/project",
      pid: 123,
      historySessionId: "resume-native",
      claudeSessionId: "active-native",
    };
    const handlers = new RelayHistoryHandlers({
      relaySend: (data) => sent.push(data),
      sessionManager: { getSession: () => session } as never,
      permissionBroker: new PermissionBroker(),
    });

    handlers.onSessionMessagesRequest({
      type: "session_messages_request",
      sessionId: "s1",
      requestId: "history-1",
    } as ControlMessage<"session_messages_request">);

    await vi.waitFor(() =>
      expect(sent.some((raw) => JSON.parse(raw).type === "session_history_messages")).toBe(true),
    );

    const history = sent
      .map((raw) => JSON.parse(raw) as { type?: string; messages?: unknown[]; nextBefore?: string })
      .find((msg) => msg.type === "session_history_messages");

    expect(mockedReadSessionMessagesPage).toHaveBeenCalledWith(
      "resume-native",
      {
        before: undefined,
        limit: undefined,
      },
      "claude",
    );
    expect(mockedReadSessionMessagesPage).toHaveBeenCalledWith(
      "active-native",
      {
        before: undefined,
        limit: undefined,
      },
      "claude",
    );
    expect(history?.messages).toEqual([
      { role: "user", text: "旧问题", cursor: "resume:b:100", timestamp: 100 },
      { role: "assistant", text: "旧回答", cursor: "resume:b:200", timestamp: 200 },
      { role: "assistant", text: "新回答", cursor: "active:b:10", timestamp: 300 },
    ]);
    expect(history?.nextBefore).toBe("resume:b:100");
  });

  it("continues older-page requests against the resumed transcript cursor", async () => {
    mockedReadSessionMessagesPage.mockResolvedValue({
      messages: [{ role: "user", text: "更早的问题", cursor: "b:50", timestamp: 50 }],
      hasMore: false,
    });

    const sent: string[] = [];
    const session: SessionInfo = {
      id: "s1",
      mode: "json",
      provider: "claude",
      state: SessionState.IDLE,
      createdAt: 1,
      updatedAt: 1,
      cwd: "/tmp/project",
      pid: 123,
      historySessionId: "resume-native",
      claudeSessionId: "active-native",
    };
    const handlers = new RelayHistoryHandlers({
      relaySend: (data) => sent.push(data),
      sessionManager: { getSession: () => session } as never,
      permissionBroker: new PermissionBroker(),
    });

    handlers.onSessionMessagesRequest({
      type: "session_messages_request",
      sessionId: "s1",
      requestId: "history-older",
      before: "resume:b:100",
    } as ControlMessage<"session_messages_request">);

    await vi.waitFor(() =>
      expect(sent.some((raw) => JSON.parse(raw).type === "session_history_messages")).toBe(true),
    );

    expect(mockedReadSessionMessagesPage).toHaveBeenCalledTimes(1);
    expect(mockedReadSessionMessagesPage).toHaveBeenCalledWith(
      "resume-native",
      {
        before: "b:100",
        limit: undefined,
      },
      "claude",
    );
  });
});
