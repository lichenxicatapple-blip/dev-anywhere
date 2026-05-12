// hostedPty fixture: 在 localRuntime 上面接 client WS, 走 register/select/session_create 链
// 拿到 sessionId 给 spec 用, 拆掉时 session_terminate.
//
// 依赖: 测试机必须装真 claude CLI (PATH 上找得到), 否则 hosted PTY spawn 报
// "claude not found in PATH" — 见 feedback_no_fake_binaries_in_e2e.md, 这里不用假 binary 绕。
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { test as runtimeTest, type LocalRuntime } from "./local-runtime";

const require = createRequire(import.meta.url);
// 复用 monorepo 已经在用的 ws@8 (relay/proxy 都依赖), 不再单独装一份.
const WebSocket = require(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../node_modules/.pnpm/ws@8.20.0/node_modules/ws",
)) as typeof import("ws");

interface HostedPtySession {
  sessionId: string;
  proxyId: string;
  cwd: string;
  // 主动终止 session, 一般 fixture 自己会在 teardown 调一次, spec 不必显式用.
  terminate: () => Promise<void>;
}

interface Fixtures {
  hostedPty: HostedPtySession;
}

const REQ_TIMEOUT_MS = 10_000;

class ClientWs {
  private ws: import("ws").WebSocket;
  private reqId = 0;
  private waiters = new Map<string, (msg: unknown) => void>();
  private opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolveFn, reject) => {
      this.ws.once("open", () => resolveFn());
      this.ws.once("error", reject);
    });
    this.ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as { requestId?: string };
        if (msg.requestId && this.waiters.has(msg.requestId)) {
          this.waiters.get(msg.requestId)!(msg);
          this.waiters.delete(msg.requestId);
        }
      } catch {
        /* binary frame, 测试侧不消费 */
      }
    });
  }

  async ready(): Promise<void> {
    await this.opened;
  }

  send(payload: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(payload));
  }

  async request<T>(type: string, body: Record<string, unknown> = {}): Promise<T> {
    const requestId = `e2e-${type}-${++this.reqId}`;
    const result = new Promise<T>((resolveFn, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new Error(`hostedPty: ${type} 等响应超时 (${REQ_TIMEOUT_MS}ms)`));
      }, REQ_TIMEOUT_MS);
      this.waiters.set(requestId, (msg) => {
        clearTimeout(t);
        resolveFn(msg as T);
      });
    });
    this.send({ ...body, type, requestId });
    return result;
  }

  close(): void {
    this.ws.close();
  }
}

async function spawnHostedPty(
  runtime: LocalRuntime,
  cwd: string,
): Promise<HostedPtySession> {
  // relay client ws 路径 /client (proxy 走 /proxy). 测试 relay 无 token, 直连即可.
  const ws = new ClientWs(`${runtime.relayUrl}/client`);
  await ws.ready();

  const clientId = `e2e-client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ws.send({ type: "client_register", clientId });

  const proxiesResp = await ws.request<{
    proxies: Array<{ proxyId: string }>;
  }>("proxy_list_request");
  const proxyId = proxiesResp.proxies[0]?.proxyId;
  if (!proxyId) throw new Error("hostedPty: relay 上还没有 proxy 注册");

  const selectResp = await ws.request<{ success: boolean; error?: string }>("proxy_select", {
    proxyId,
  });
  if (!selectResp.success) throw new Error(`hostedPty: proxy_select 失败: ${selectResp.error}`);

  const createResp = await ws.request<{ sessionId?: string; error?: string }>("session_create", {
    cwd,
    provider: "claude",
    mode: "pty",
  });
  if (!createResp.sessionId) {
    throw new Error(`hostedPty: session_create 失败: ${createResp.error ?? "无 sessionId"}`);
  }

  const sessionId = createResp.sessionId;
  return {
    sessionId,
    proxyId,
    cwd,
    terminate: async () => {
      try {
        await ws.request("session_terminate", { sessionId }).catch(() => {});
      } finally {
        ws.close();
      }
    },
  };
}

function claudeOnPath(): boolean {
  try {
    execSync("command -v claude", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export const test = runtimeTest.extend<Fixtures>({
  hostedPty: async ({ localRuntime }, use, testInfo) => {
    if (!claudeOnPath()) {
      testInfo.skip(true, "hostedPty fixture 需要真 claude CLI (PATH 找不到)");
      return;
    }
    const session = await spawnHostedPty(localRuntime, "/tmp");
    try {
      await use(session);
    } finally {
      await session.terminate();
    }
  },
});

export { expect } from "@playwright/test";
