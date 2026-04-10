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

  // 发送 MessageEnvelope
  sendEnvelope(envelope: MessageEnvelope): void {
    this.ws.send(JSON.stringify(envelope));
  }

  // 发送控制消息
  sendControl(msg: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(msg));
  }

  // 更新某个 session 的已接收 seq
  updateSeq(sessionId: string, seq: number): void {
    this.sessionSeqMap[sessionId] = seq;
  }

  getBoundProxyId(): string | null {
    return this.boundProxyId;
  }

  // 注册收到消息的回调，解析 JSON 并分发
  onMessage(handler: (msg: MessageEnvelope | RelayControlMessage) => void): () => void {
    this.messageHandlers.add(handler);

    const unsub = this.ws.onMessage((raw) => {
      try {
        const parsed = JSON.parse(raw) as MessageEnvelope | RelayControlMessage;
        handler(parsed);
      } catch {
        // invalid JSON, log and drop per T-06-18 mitigation
        console.warn("RelayClient: failed to parse incoming message");
      }
    });

    return () => {
      this.messageHandlers.delete(handler);
      unsub();
    };
  }
}
