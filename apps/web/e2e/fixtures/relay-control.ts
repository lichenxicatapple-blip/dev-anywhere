// 共享: client WS 连 relay + register/select/session_create 协议套路.
// hostedPty / jsonMode fixture 的差别只在 session_create 的 mode 字段, 其余走同一条路.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { LocalRuntime } from "./local-runtime";

const require = createRequire(import.meta.url);
const WebSocket = require(resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../node_modules/.pnpm/ws@8.20.0/node_modules/ws",
)) as typeof import("ws");

const REQ_TIMEOUT_MS = 15_000;

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
        /* binary frame */
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
        reject(new Error(`relay-control: ${type} 等响应超时 (${REQ_TIMEOUT_MS}ms)`));
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

export interface SessionViaRelay {
  sessionId: string;
  proxyId: string;
  cwd: string;
  mode: "pty" | "json";
  // teardown: 发 session_terminate 并关 ws.
  terminate: () => Promise<void>;
}

export interface SpawnSessionOptions {
  mode: "pty" | "json";
  cwd: string;
  provider: "claude" | "codex";
}

export async function spawnSessionViaRelay(
  runtime: LocalRuntime,
  options: SpawnSessionOptions,
): Promise<SessionViaRelay> {
  const ws = new ClientWs(`${runtime.relayUrl}/client`);
  await ws.ready();

  const clientId = `e2e-client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ws.send({ type: "client_register", clientId });

  const proxiesResp = await ws.request<{
    proxies: Array<{ proxyId: string }>;
  }>("proxy_list_request");
  const proxyId = proxiesResp.proxies[0]?.proxyId;
  if (!proxyId) throw new Error("relay-control: relay 上还没有 proxy 注册");

  const selectResp = await ws.request<{ success: boolean; error?: string }>("proxy_select", {
    proxyId,
  });
  if (!selectResp.success) {
    throw new Error(`relay-control: proxy_select 失败: ${selectResp.error}`);
  }

  const createResp = await ws.request<{ sessionId?: string; error?: string }>("session_create", {
    cwd: options.cwd,
    provider: options.provider,
    mode: options.mode,
  });
  if (!createResp.sessionId) {
    throw new Error(
      `relay-control: session_create(mode=${options.mode}) 失败: ${createResp.error ?? "无 sessionId"}`,
    );
  }

  const sessionId = createResp.sessionId;
  return {
    sessionId,
    proxyId,
    cwd: options.cwd,
    mode: options.mode,
    terminate: async () => {
      try {
        await ws.request("session_terminate", { sessionId }).catch(() => {});
      } finally {
        ws.close();
      }
    },
  };
}
