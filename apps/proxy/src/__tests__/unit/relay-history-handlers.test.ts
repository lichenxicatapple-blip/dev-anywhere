import { describe, expect, it } from "vitest";
import type { ControlMessage } from "@dev-anywhere/shared";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import { RelayHistoryHandlers } from "#src/serve/relay-history-handlers.js";

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
