import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MessageEnvelopeSchema } from "@dev-anywhere/shared";
import { WorkerRegistry } from "#src/serve/worker-registry.js";
import { PermissionBroker } from "#src/serve/permission-broker.js";
import {
  createJsonObserverFake,
  createRelayConnectionFake,
  createSessionManagerFake,
} from "./test-fakes.js";

// 拿真实 claude CLI control_request fixture 端到端验证 forwardApprovalRequest：
// 真实 tool_name + request.input 喂进去 → 检查出站 tool_use_request envelope shape 合法，
// 保证 CLI 吐出的 input（嵌套对象、特殊字符等）能原样搬进 MessageEnvelope 协议。
const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/stream-json/claude-2.1.116/control-request.jsonl",
);

function readFixtureControlRequest(): {
  request_id: string;
  request: { tool_name: string; input: Record<string, unknown> };
} {
  const events = readFileSync(FIXTURE_PATH, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
  const req = events.find((e) => e && typeof e === "object" && e.type === "control_request");
  if (!req) throw new Error("fixture missing control_request event");
  return req;
}

describe("forwardApprovalRequest (real CLI control_request data)", () => {
  it("emits a MessageEnvelope-valid tool_use_request that preserves tool_name/request_id/input", () => {
    const fixtureReq = readFixtureControlRequest();
    const relay = createRelayConnectionFake();

    const permissionBroker = new PermissionBroker();
    const registry = new WorkerRegistry({
      sessionManager: createSessionManagerFake([{ id: "session-real-data", provider: "claude" }]),
      permissionBroker,
      relayConnection: relay.relayConnection,
      jsonObserver: createJsonObserverFake(),
      getProviderEnv: () => ({}),
      nextSeq: () => 1,
    });

    // 合成 worker → serve 的 IPC 消息，内容全部取自真实 fixture
    const ipcMsg = {
      type: "worker_approval_request" as const,
      requestId: fixtureReq.request_id,
      toolName: fixtureReq.request.tool_name,
      input: fixtureReq.request.input,
    };

    // forwardApprovalRequest 是 private，测试里直接穿透访问
    (
      registry as unknown as {
        forwardApprovalRequest: (sid: string, msg: typeof ipcMsg) => void;
      }
    ).forwardApprovalRequest("session-real-data", ipcMsg);

    expect(relay.envelopes).toHaveLength(1);

    // envelope 必须能通过 shared 端的 MessageEnvelopeSchema —— 任何字段漂移或 shape 不合法都会炸
    const parsed = MessageEnvelopeSchema.safeParse(relay.envelopes[0]);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.type).toBe("tool_use_request");
    if (parsed.data.type !== "tool_use_request") return;

    expect(parsed.data.sessionId).toBe("session-real-data");
    expect(parsed.data.source).toBe("proxy");
    expect(parsed.data.payload.toolName).toBe(fixtureReq.request.tool_name);
    expect(parsed.data.payload.toolId).toBe(fixtureReq.request_id);
    // input 里 { file_path, content } 等 CLI 生成的嵌套结构必须原样 passthrough
    expect(parsed.data.payload.parameters).toEqual(fixtureReq.request.input);

    // 副作用：待审批条目已登记，后续 tool_approve/tool_deny 才能 resolve
    const pending = permissionBroker.listSession("session-real-data");
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      requestId: fixtureReq.request_id,
      provider: "claude",
      source: "worker",
      toolName: fixtureReq.request.tool_name,
      input: fixtureReq.request.input,
    });
  });
});
