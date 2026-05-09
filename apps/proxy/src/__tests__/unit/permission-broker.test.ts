import { describe, expect, it, vi } from "vitest";
import { PermissionBroker } from "#src/serve/permission-broker.js";

describe("PermissionBroker", () => {
  it("keeps permission requests pending indefinitely until explicit resolution", async () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker();
      const decisionPromise = broker.request({
        requestId: "req-wait",
        sessionId: "s1",
        provider: "claude",
        toolName: "Bash",
        input: {},
      });
      let resolved = false;
      decisionPromise.then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

      expect(resolved).toBe(false);
      expect(broker.listSession("s1")).toHaveLength(1);
      expect(broker.resolve("req-wait", { behavior: "allow" })).toBe(true);
      await expect(decisionPromise).resolves.toEqual({ behavior: "allow" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves a pending permission request by requestId", async () => {
    const broker = new PermissionBroker();
    const decisionPromise = broker.request({
      requestId: "req-1",
      sessionId: "s1",
      provider: "claude",
      toolName: "Bash",
      input: { command: "pwd" },
    });

    expect(broker.listSession("s1")).toHaveLength(1);
    expect(broker.resolve("req-1", { behavior: "allow" })).toBe(true);
    await expect(decisionPromise).resolves.toEqual({ behavior: "allow" });
    expect(broker.listSession("s1")).toHaveLength(0);
  });

  it("denies pending requests when a session is cleaned up", async () => {
    const broker = new PermissionBroker();
    const decisionPromise = broker.request({
      requestId: "req-1",
      sessionId: "s1",
      provider: "claude",
      toolName: "Write",
      input: {},
    });

    broker.cleanupSession("s1", "session ended");

    await expect(decisionPromise).resolves.toEqual({
      behavior: "deny",
      message: "session ended",
    });
    expect(broker.listSession("s1")).toHaveLength(0);
  });

  it("registers worker permission requests on the same pending path", () => {
    const broker = new PermissionBroker();
    const decisions: unknown[] = [];

    expect(
      broker.registerWorkerRequest(
        {
          requestId: "worker-req-1",
          sessionId: "s1",
          provider: "claude",
          toolName: "Write",
          input: { file_path: "/tmp/a" },
        },
        (decision) => decisions.push(decision),
      ),
    ).toBe(true);

    expect(broker.listSession("s1")[0]).toMatchObject({
      requestId: "worker-req-1",
      source: "worker",
      provider: "claude",
      toolName: "Write",
      input: { file_path: "/tmp/a" },
    });
    expect(broker.resolve("worker-req-1", { behavior: "deny", message: "No." })).toBe(true);
    expect(decisions).toEqual([{ behavior: "deny", message: "No." }]);
    expect(broker.listSession("s1")).toHaveLength(0);
  });

  it("marks pending requests as delivered", () => {
    const broker = new PermissionBroker();
    void broker.request({
      requestId: "req-1",
      sessionId: "s1",
      provider: "claude",
      toolName: "Bash",
      input: {},
    });

    expect(broker.markDelivered("req-1")).toBe(true);
    expect(broker.get("req-1")?.deliveredAt).toBeTypeOf("number");
    expect(broker.markDelivered("missing")).toBe(false);
  });
});
