import { WebSocket } from "ws";
import { SessionBuffer } from "./session-buffer.js";
import type { BufferStore } from "./buffer-store.js";

// 代理连接状态，跟踪 ws、会话集合、离线时间、显示名称
interface ProxyState {
  ws: WebSocket | null;
  sessions: Set<string>;
  disconnectedAt: number | null;
  name?: string;
}

// 客户端绑定状态，通过 clientId 而非 WebSocket 引用标识
interface ClientBinding {
  proxyId: string;
  ws: WebSocket | null;
}

// buffer 统计信息
export interface BufferStats {
  totalBuffered: number;
  sessionCount: number;
  proxyCount: number;
}

// 代理注册、客户端绑定、会话缓冲区、宽限期管理
export class RelayRegistry {
  private proxyStates = new Map<string, ProxyState>();
  private clientBindings = new Map<string, ClientBinding>();
  private sessionBuffers = new Map<string, SessionBuffer>();
  private connectedClients = new Set<WebSocket>();
  private store: BufferStore | null;

  constructor(store: BufferStore | null = null) {
    this.store = store;
    if (store) {
      const loaded = store.loadAll();
      for (const [sessionId, msgs] of loaded) {
        const buffer = new SessionBuffer(store, sessionId);
        buffer.loadMessages(msgs);
        this.sessionBuffers.set(sessionId, buffer);
      }
    }
  }

  registerProxy(proxyId: string, ws: WebSocket, name?: string): "new" | "reconnected" {
    const existing = this.proxyStates.get(proxyId);
    if (existing) {
      // 如果旧连接还活着，先终止
      if (existing.ws && existing.ws.readyState === WebSocket.OPEN) {
        existing.ws.terminate();
      }
      existing.ws = ws;
      existing.disconnectedAt = null;
      if (name !== undefined) existing.name = name;
      return "reconnected";
    }

    this.proxyStates.set(proxyId, {
      ws,
      sessions: new Set(),
      disconnectedAt: null,
      name,
    });
    return "new";
  }

  // 标记 proxy 离线，保留所有状态等待重连，不设超时
  // 清理只在 proxy 主动退出（proxy_disconnect）或 relay 启动清理废弃数据时发生
  markProxyOffline(proxyId: string): void {
    const state = this.proxyStates.get(proxyId);
    if (!state) return;

    state.ws = null;
    state.disconnectedAt = Date.now();
  }

  // 彻底清理 proxy 状态、会话缓冲区、客户端绑定
  cleanupProxy(proxyId: string): void {
    const state = this.proxyStates.get(proxyId);
    if (!state) return;

    // 清理该 proxy 拥有的所有会话缓冲区（含磁盘文件）
    for (const sessionId of state.sessions) {
      const buffer = this.sessionBuffers.get(sessionId);
      if (buffer) {
        buffer.clear();
      }
      this.sessionBuffers.delete(sessionId);
    }

    // 解绑所有绑定到该 proxy 的客户端
    for (const [clientId, binding] of this.clientBindings) {
      if (binding.proxyId === proxyId) {
        this.clientBindings.delete(clientId);
      }
    }

    this.proxyStates.delete(proxyId);
  }

  unregisterProxy(proxyId: string): void {
    this.cleanupProxy(proxyId);
  }

  getProxy(proxyId: string): WebSocket | undefined {
    const state = this.proxyStates.get(proxyId);
    return state?.ws ?? undefined;
  }

  isProxyOnline(proxyId: string): boolean {
    const state = this.proxyStates.get(proxyId);
    return state?.ws !== null && state?.ws !== undefined && state.ws.readyState === WebSocket.OPEN;
  }

  // proxy 是否存在（含宽限期中的）
  hasProxy(proxyId: string): boolean {
    return this.proxyStates.has(proxyId);
  }

  listProxies(): string[] {
    return Array.from(this.proxyStates.keys());
  }

  // 返回 proxyId、name、online 的列表，用于 proxy_list_response
  listProxiesWithName(): Array<{ proxyId: string; name?: string; online: boolean }> {
    return Array.from(this.proxyStates.entries()).map(([proxyId, state]) => ({
      proxyId,
      ...(state.name !== undefined ? { name: state.name } : {}),
      online: state.ws !== null && state.ws !== undefined && state.ws.readyState === WebSocket.OPEN,
    }));
  }

  getProxyName(proxyId: string): string | undefined {
    return this.proxyStates.get(proxyId)?.name;
  }

  // 将 sessionId 关联到 proxy
  addSessionToProxy(proxyId: string, sessionId: string): void {
    const state = this.proxyStates.get(proxyId);
    if (state) {
      state.sessions.add(sessionId);
    }
  }

  // 获取 proxy 关联的所有 sessionId
  getSessionsForProxy(proxyId: string): string[] {
    const state = this.proxyStates.get(proxyId);
    return state ? Array.from(state.sessions) : [];
  }

  getOrCreateSessionBuffer(sessionId: string): SessionBuffer {
    let buffer = this.sessionBuffers.get(sessionId);
    if (!buffer) {
      buffer = new SessionBuffer(this.store, sessionId);
      this.sessionBuffers.set(sessionId, buffer);
    }
    return buffer;
  }

  getSessionBuffer(sessionId: string): SessionBuffer | undefined {
    return this.sessionBuffers.get(sessionId);
  }

  // 获取 proxy 所有 session 的最大 seq 映射，用于重连对账
  getSessionSeqMap(proxyId: string): Record<string, number> {
    const sessionIds = this.getSessionsForProxy(proxyId);
    const map: Record<string, number> = {};
    for (const sessionId of sessionIds) {
      const buffer = this.sessionBuffers.get(sessionId);
      if (buffer && buffer.size() > 0) {
        map[sessionId] = buffer.getLastSeq();
      }
    }
    return map;
  }

  // clientId 绑定方式
  bindClientById(clientId: string, proxyId: string, ws: WebSocket): boolean {
    if (!this.proxyStates.has(proxyId)) {
      return false;
    }
    this.clientBindings.set(clientId, { proxyId, ws });
    return true;
  }

  updateClientSocket(clientId: string, ws: WebSocket): void {
    const binding = this.clientBindings.get(clientId);
    if (binding) {
      binding.ws = ws;
    }
  }

  // 断开客户端 WebSocket 但保留绑定关系，重连时可恢复
  unbindClientById(clientId: string): void {
    const binding = this.clientBindings.get(clientId);
    if (binding) {
      binding.ws = null;
    }
  }

  getClientBinding(clientId: string): ClientBinding | undefined {
    return this.clientBindings.get(clientId);
  }

  // 获取绑定到指定 proxy 的所有活跃客户端 WebSocket
  getClientsForProxy(proxyId: string): WebSocket[] {
    const clients: WebSocket[] = [];
    for (const [, binding] of this.clientBindings) {
      if (binding.proxyId === proxyId && binding.ws && binding.ws.readyState === WebSocket.OPEN) {
        clients.push(binding.ws);
      }
    }
    return clients;
  }

  countClients(): number {
    let count = 0;
    for (const [, binding] of this.clientBindings) {
      if (binding.ws) count++;
    }
    return count;
  }

  addClientWs(ws: WebSocket): void {
    this.connectedClients.add(ws);
  }

  removeClientWs(ws: WebSocket): void {
    this.connectedClients.delete(ws);
  }

  getAllClientWs(): WebSocket[] {
    const clients: WebSocket[] = [];
    for (const ws of this.connectedClients) {
      if (ws.readyState === WebSocket.OPEN) {
        clients.push(ws);
      }
    }
    return clients;
  }


  getBufferStats(): BufferStats {
    let totalBuffered = 0;
    for (const [, buffer] of this.sessionBuffers) {
      totalBuffered += buffer.size();
    }
    return {
      totalBuffered,
      sessionCount: this.sessionBuffers.size,
      proxyCount: this.proxyStates.size,
    };
  }
}
