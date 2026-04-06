import type { WebSocket } from "ws";

// 代理注册和客户端绑定管理
export class RelayRegistry {
  private proxies = new Map<string, WebSocket>();
  private clientBindings = new Map<WebSocket, string>();

  registerProxy(proxyId: string, ws: WebSocket): void {
    const existing = this.proxies.get(proxyId);
    if (existing) {
      existing.terminate();
    }
    this.proxies.set(proxyId, ws);
  }

  unregisterProxy(proxyId: string): void {
    this.proxies.delete(proxyId);
    for (const [clientWs, boundProxyId] of this.clientBindings) {
      if (boundProxyId === proxyId) {
        this.clientBindings.delete(clientWs);
      }
    }
  }

  getProxy(proxyId: string): WebSocket | undefined {
    return this.proxies.get(proxyId);
  }

  listProxies(): string[] {
    return Array.from(this.proxies.keys());
  }

  bindClient(clientWs: WebSocket, proxyId: string): boolean {
    if (!this.proxies.has(proxyId)) {
      return false;
    }
    this.clientBindings.set(clientWs, proxyId);
    return true;
  }

  unbindClient(clientWs: WebSocket): void {
    this.clientBindings.delete(clientWs);
  }

  getClientsForProxy(proxyId: string): WebSocket[] {
    const clients: WebSocket[] = [];
    for (const [clientWs, boundProxyId] of this.clientBindings) {
      if (boundProxyId === proxyId) {
        clients.push(clientWs);
      }
    }
    return clients;
  }

  getBoundProxy(clientWs: WebSocket): string | undefined {
    return this.clientBindings.get(clientWs);
  }

  countClients(): number {
    return this.clientBindings.size;
  }
}
