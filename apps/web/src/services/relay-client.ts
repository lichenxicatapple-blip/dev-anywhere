// Relay 协议客户端，处理注册、代理选择、消息发送和控制消息路由
import type { WebSocketManager } from "@/services/websocket";
import type { MessageEnvelope, RelayControlMessage } from "@dev-anywhere/shared";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

type InboundMessage = MessageEnvelope | RelayControlMessage;
type ProxyInfoResult = Array<{
  proxyId: string;
  name?: string;
  online: boolean;
  sessions?: string[];
}>;
type RelayTransport = Pick<WebSocketManager, "onMessage" | "onStatusChange" | "send">;
type SessionCreateRequest = Extract<RelayControlMessage, { type: "session_create" }>;
type SessionCreateResponse = Extract<RelayControlMessage, { type: "session_create_response" }>;

let requestSeq = 0;

function nextRequestId(prefix: string): string {
  requestSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${requestSeq.toString(36)}`;
}

export class RelayClient {
  private ws: RelayTransport;
  private clientId: string;
  private boundProxyId: string | null = null;
  private messageHandlers = new Set<(msg: InboundMessage) => void>();
  private pendingMessages: InboundMessage[] = [];

  constructor(ws: RelayTransport, clientId: string) {
    this.ws = ws;
    this.clientId = clientId;

    // 只注册一次 ws listener，收到消息后分发给所有 handler
    // handler 未注册时先缓冲，等 onMessage 注册后 flush
    this.ws.onMessage((raw) => {
      let parsed: InboundMessage;
      try {
        parsed = JSON.parse(raw) as MessageEnvelope | RelayControlMessage;
      } catch (e) {
        console.warn("RelayClient: failed to parse JSON:", raw.slice(0, 200), e);
        return;
      }
      if (this.messageHandlers.size === 0) {
        this.pendingMessages.push(parsed);
        return;
      }
      this.dispatch(parsed);
    });
  }

  private dispatch(msg: InboundMessage): void {
    this.messageHandlers.forEach((h) => {
      try {
        h(msg);
      } catch (e) {
        console.warn("RelayClient: message handler error:", (msg as { type?: string }).type, e);
      }
    });
  }

  // 发送 client_register，携带 clientId 和各 session 已收到的最大 seq
  // 注册意味着新连接，旧绑定对新 relay 实例无效
  register(): void {
    this.boundProxyId = null;
    this.ws.send(
      JSON.stringify({
        type: "client_register",
        clientId: this.clientId,
      }),
    );
  }

  // 请求可用代理列表（fire-and-forget，响应通过 onMessage 处理）
  listProxies(): void {
    this.ws.send(JSON.stringify({ type: "proxy_list_request" }));
  }

  // 请求代理列表并返回 Promise，等待 proxy_list_response 响应
  requestProxyList(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<ProxyInfoResult> {
    const requestId = nextRequestId("proxy-list");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "proxy_list_response" }> =>
        msg.type === "proxy_list_response" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "proxy_list_request", requestId })),
      "请求电脑列表超时",
      timeoutMs,
    ).then((msg) => msg.proxies as ProxyInfoResult);
  }

  // 选择并绑定一个代理，返回 Promise 等待 proxy_select_response ACK
  selectProxy(
    proxyId: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<{ success: boolean; proxyId?: string; error?: string }> {
    const requestId = nextRequestId("proxy-select");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "proxy_select_response" }> =>
        msg.type === "proxy_select_response" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "proxy_select", requestId, proxyId })),
      "连接电脑超时",
      timeoutMs,
    ).then((resp) => {
      if (resp.success) {
        this.boundProxyId = proxyId;
      }
      return {
        success: resp.success,
        proxyId: resp.proxyId,
        error: resp.error,
      };
    });
  }

  createDirectory(
    path: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<{ success: boolean; path: string; error?: string }> {
    const requestId = nextRequestId("dir-create");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "dir_create_response" }> =>
        msg.type === "dir_create_response" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "dir_create_request", requestId, path })),
      "创建目录超时",
      timeoutMs,
    ).then((resp) => ({
      success: resp.success,
      path: resp.path,
      error: resp.error,
    }));
  }

  createSession(
    request: Omit<SessionCreateRequest, "type" | "requestId">,
    timeoutMs = 15_000,
  ): Promise<SessionCreateResponse> {
    const requestId = nextRequestId("session-create");
    return this.waitForMessage(
      (msg): msg is SessionCreateResponse =>
        msg.type === "session_create_response" && msg.requestId === requestId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "session_create",
            requestId,
            ...request,
          }),
        ),
      "创建超时，请检查本机连接后重试",
      timeoutMs,
    );
  }

  // 发送 MessageEnvelope
  sendEnvelope(envelope: MessageEnvelope): void {
    this.ws.send(JSON.stringify(envelope));
  }

  // 发送控制消息
  sendControl(msg: RelayControlMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  private waitForMessage<T extends InboundMessage>(
    predicate: (msg: InboundMessage) => msg is T,
    send: () => boolean | void,
    timeoutMessage: string,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribeMessage: (() => void) | null = null;
      let unsubscribeStatus: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (): void => {
        unsubscribeMessage?.();
        unsubscribeStatus?.();
        if (timer) clearTimeout(timer);
      };

      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };

      unsubscribeMessage = this.onMessage((msg) => {
        if (!predicate(msg)) return;
        settle(() => resolve(msg));
      });
      unsubscribeStatus = this.ws.onStatusChange((connected) => {
        if (connected) return;
        settle(() => reject(new Error("连接已断开")));
      });
      timer = setTimeout(() => {
        settle(() => reject(new Error(timeoutMessage)));
      }, timeoutMs);

      try {
        const sent = send();
        if (sent === false) {
          settle(() => reject(new Error("连接已断开")));
        }
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }

  getBoundProxyId(): string | null {
    return this.boundProxyId;
  }

  // 注册收到消息的回调，返回取消注册函数
  onMessage(handler: (msg: InboundMessage) => void): () => void {
    this.messageHandlers.add(handler);
    if (this.pendingMessages.length > 0) {
      const buffered = this.pendingMessages;
      this.pendingMessages = [];
      for (const msg of buffered) {
        this.dispatch(msg);
      }
    }
    return () => {
      this.messageHandlers.delete(handler);
    };
  }
}
