// Relay 协议客户端，处理注册、代理选择、消息发送和控制消息路由
import type { WebSocketManager } from "@/services/websocket";
import type { MessageEnvelope, RelayControlMessage } from "@cc-anywhere/shared";

export class RelayClient {
  private ws: WebSocketManager;
  private clientId: string;
  private boundProxyId: string | null = null;
  private sessionSeqMap: Record<string, number> = {};
  private messageHandlers = new Set<(msg: MessageEnvelope | RelayControlMessage) => void>();

  constructor(ws: WebSocketManager, clientId: string) {
    this.ws = ws;
    this.clientId = clientId;

    // 只注册一次 ws listener，收到消息后分发给所有 handler
    this.ws.onMessage((raw) => {
      try {
        const parsed = JSON.parse(raw) as MessageEnvelope | RelayControlMessage;
        // bind_by_session 成功时更新本地绑定状态
        if ("type" in parsed && (parsed as Record<string, unknown>).type === "bind_by_session_response") {
          const resp = parsed as Record<string, unknown>;
          if (resp.success && typeof resp.proxyId === "string") {
            this.boundProxyId = resp.proxyId;
          }
        }
        this.messageHandlers.forEach((h) => h(parsed));
      } catch (e) {
        console.warn("RelayClient: failed to parse incoming message:", raw.slice(0, 200), e);
      }
    });
  }

  // 发送 client_register，携带 clientId 和各 session 已收到的最大 seq
  register(): void {
    this.ws.send(
      JSON.stringify({
        type: "client_register",
        clientId: this.clientId,
        sessions: this.sessionSeqMap,
      }),
    );
  }

  // 请求可用代理列表
  listProxies(): void {
    this.ws.send(JSON.stringify({ type: "proxy_list_request" }));
  }

  // 选择并绑定一个代理
  selectProxy(proxyId: string): void {
    this.ws.send(JSON.stringify({ type: "proxy_select", proxyId }));
    this.boundProxyId = proxyId;
  }

  // 通过 sessionId 绑定到拥有该 session 的 proxy
  bindBySession(sessionId: string): void {
    this.ws.send(JSON.stringify({ type: "bind_by_session", sessionId }));
  }

  // 发送 MessageEnvelope
  sendEnvelope(envelope: MessageEnvelope): void {
    this.ws.send(JSON.stringify(envelope));
  }

  // 发送控制消息
  sendControl(msg: RelayControlMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  // 更新某个 session 的已接收 seq
  updateSeq(sessionId: string, seq: number): void {
    this.sessionSeqMap[sessionId] = seq;
  }

  getBoundProxyId(): string | null {
    return this.boundProxyId;
  }

  // 注册收到消息的回调，返回取消注册函数
  onMessage(handler: (msg: MessageEnvelope | RelayControlMessage) => void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }
}
