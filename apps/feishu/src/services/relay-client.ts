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
      let parsed: MessageEnvelope | RelayControlMessage;
      try {
        parsed = JSON.parse(raw) as MessageEnvelope | RelayControlMessage;
      } catch (e) {
        console.warn("RelayClient: failed to parse JSON:", raw.slice(0, 200), e);
        return;
      }
      this.messageHandlers.forEach((h) => {
        try {
          h(parsed);
        } catch (e) {
          console.warn("RelayClient: message handler error:", parsed.type, e);
        }
      });
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
        sessions: this.sessionSeqMap,
      }),
    );
  }

  // 请求可用代理列表（fire-and-forget，响应通过 onMessage 处理）
  listProxies(): void {
    this.ws.send(JSON.stringify({ type: "proxy_list_request" }));
  }

  // 请求代理列表并返回 Promise，等待 proxy_list_response 响应
  requestProxyList(): Promise<Array<{ proxyId: string; name?: string; online: boolean; sessions?: string[] }>> {
    return new Promise((resolve) => {
      const unsub = this.onMessage((msg) => {
        if ("type" in msg && (msg as Record<string, unknown>).type === "proxy_list_response") {
          unsub();
          resolve((msg as Record<string, unknown>).proxies as Array<{ proxyId: string; name?: string; online: boolean; sessions?: string[] }>);
        }
      });
      this.ws.send(JSON.stringify({ type: "proxy_list_request" }));
    });
  }

  // 选择并绑定一个代理，返回 Promise 等待 proxy_select_response ACK
  selectProxy(proxyId: string): Promise<{ success: boolean; proxyId?: string; error?: string }> {
    return new Promise((resolve) => {
      const unsub = this.onMessage((msg) => {
        if ("type" in msg && (msg as Record<string, unknown>).type === "proxy_select_response") {
          unsub();
          const resp = msg as Record<string, unknown>;
          if (resp.success) {
            this.boundProxyId = proxyId;
          }
          resolve({
            success: resp.success as boolean,
            proxyId: resp.proxyId as string | undefined,
            error: resp.error as string | undefined,
          });
        }
      });
      this.ws.send(JSON.stringify({ type: "proxy_select", proxyId }));
    });
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
