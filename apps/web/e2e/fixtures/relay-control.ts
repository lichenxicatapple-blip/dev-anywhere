// 共享: client WS 连 relay + register/select/session_create 协议套路.
// hostedPty / jsonMode fixture 的差别只在 session_create 的 mode 字段, 其余走同一条路.
// 用 Node 22+ 内置 WebSocket (W3C EventTarget 风格).
import type { LocalRuntime } from "./local-runtime";

const REQ_TIMEOUT_MS = 15_000;

class ClientWs {
  private ws: WebSocket;
  private reqId = 0;
  private waiters = new Map<string, (msg: unknown) => void>();
  private opened: Promise<void>;
  private jsonListeners = new Set<(msg: Record<string, unknown>) => void>();
  private binaryListeners = new Set<(buf: ArrayBuffer) => void>();

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.opened = new Promise((resolveFn, reject) => {
      this.ws.addEventListener("open", () => resolveFn(), { once: true });
      this.ws.addEventListener(
        "error",
        () => reject(new Error(`relay-control: ws error connecting ${url}`)),
        { once: true },
      );
    });
    this.ws.addEventListener("message", (e: MessageEvent) => {
      if (typeof e.data === "string") {
        try {
          const msg = JSON.parse(e.data) as Record<string, unknown>;
          const requestId = msg.requestId as string | undefined;
          if (requestId && this.waiters.has(requestId)) {
            this.waiters.get(requestId)!(msg);
            this.waiters.delete(requestId);
          }
          for (const handler of this.jsonListeners) handler(msg);
        } catch {
          /* not JSON */
        }
      } else if (e.data instanceof ArrayBuffer) {
        for (const handler of this.binaryListeners) handler(e.data);
      }
    });
  }

  onJson(handler: (msg: Record<string, unknown>) => void): () => void {
    this.jsonListeners.add(handler);
    return () => this.jsonListeners.delete(handler);
  }

  onBinary(handler: (buf: ArrayBuffer) => void): () => void {
    this.binaryListeners.add(handler);
    return () => this.binaryListeners.delete(handler);
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
  // 主动发协议消息到 relay (e.g. session_subscribe / user_input).
  send: (payload: Record<string, unknown>) => void;
  // 订阅所有 JSON envelope (含 broadcast). 返回 dispose.
  onJson: (handler: (msg: Record<string, unknown>) => void) => () => void;
  // 订阅 binary PTY frame. 返回 dispose. payload 解码: 1B sid 长度 + sid + 4B seq + bytes.
  onBinary: (handler: (buf: ArrayBuffer) => void) => () => void;
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
    send: (payload) => ws.send(payload),
    onJson: (handler) => ws.onJson(handler),
    onBinary: (handler) => ws.onBinary(handler),
    terminate: async () => {
      try {
        await ws.request("session_terminate", { sessionId }).catch(() => {});
      } finally {
        ws.close();
      }
    },
  };
}
