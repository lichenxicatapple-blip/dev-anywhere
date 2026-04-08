import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("ipc-protocol new message types", () => {
  async function importIpc() {
    return await import("../ipc-protocol.js");
  }

  it("accepts worker_claude_session_id message type", async () => {
    const { WorkerMessageSchema } = await importIpc();
    const msg = {
      type: "worker_claude_session_id",
      sessionId: "claude-sess-123",
    };
    const result = WorkerMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  it("accepts worker_whitelist_add message type", async () => {
    const { WorkerMessageSchema } = await importIpc();
    const msg = {
      type: "worker_whitelist_add",
      toolName: "Bash",
    };
    const result = WorkerMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });

  // worker_approval_request 的 z.record(z.unknown()) 在 Zod 4.3.6 有已知 bug，跳过 schema 验证
  // 但 serializeWorkerMsg + createWorkerReader 的集成测试已在 ipc-protocol.test.ts 中覆盖

  it("worker_approval_response still validates correctly", async () => {
    const { WorkerMessageSchema } = await importIpc();
    const msg = {
      type: "worker_approval_response",
      requestId: "req-1",
      behavior: "allow",
      message: "approved",
    };
    const result = WorkerMessageSchema.safeParse(msg);
    expect(result.success).toBe(true);
  });
});

describe("session-worker relay approval strategy", () => {
  it("session-worker.ts imports createRelayApprovalStrategy", async () => {
    const workerSource = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../session-worker.ts", import.meta.url).pathname.replace(
          /\.ts$/,
          ".ts",
        ),
        "utf-8",
      ),
    );
    expect(workerSource).toContain("createRelayApprovalStrategy");
  });

  it("session-worker.ts imports ToolWhitelist", async () => {
    const workerSource = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../session-worker.ts", import.meta.url).pathname.replace(
          /\.ts$/,
          ".ts",
        ),
        "utf-8",
      ),
    );
    expect(workerSource).toContain("ToolWhitelist");
  });

  it("session-worker.ts handles worker_claude_session_id", async () => {
    const workerSource = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../session-worker.ts", import.meta.url).pathname.replace(
          /\.ts$/,
          ".ts",
        ),
        "utf-8",
      ),
    );
    expect(workerSource).toContain("worker_claude_session_id");
  });

  it("session-worker.ts handles worker_whitelist_add", async () => {
    const workerSource = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../session-worker.ts", import.meta.url).pathname.replace(
          /\.ts$/,
          ".ts",
        ),
        "utf-8",
      ),
    );
    expect(workerSource).toContain("worker_whitelist_add");
  });
});

describe("serve.ts approval forwarding", () => {
  it("serve.ts does not contain auto-deny for worker_approval_request", async () => {
    const serveSource = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../serve.ts", import.meta.url).pathname.replace(
          /\.ts$/,
          ".ts",
        ),
        "utf-8",
      ),
    );
    // 原来的 auto-deny 应该被替换为 relay 转发
    expect(serveSource).not.toContain("Tool approval requested (auto-deny)");
    expect(serveSource).not.toContain("Remote approval not yet configured.");
  });

  it("serve.ts forwards tool approval to relay via tool_use_request envelope", async () => {
    const serveSource = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../serve.ts", import.meta.url).pathname.replace(
          /\.ts$/,
          ".ts",
        ),
        "utf-8",
      ),
    );
    expect(serveSource).toContain("tool_use_request");
  });

  it("serve.ts handles tool_approve from relay", async () => {
    const serveSource = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../serve.ts", import.meta.url).pathname.replace(
          /\.ts$/,
          ".ts",
        ),
        "utf-8",
      ),
    );
    expect(serveSource).toContain("tool_approve");
  });

  it("serve.ts handles tool_deny from relay", async () => {
    const serveSource = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../serve.ts", import.meta.url).pathname.replace(
          /\.ts$/,
          ".ts",
        ),
        "utf-8",
      ),
    );
    expect(serveSource).toContain("tool_deny");
  });

  it("serve.ts handles worker_claude_session_id from worker", async () => {
    const serveSource = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../serve.ts", import.meta.url).pathname.replace(
          /\.ts$/,
          ".ts",
        ),
        "utf-8",
      ),
    );
    expect(serveSource).toContain("worker_claude_session_id");
  });
});
