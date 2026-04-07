import { WebSocket } from "ws";
import { SessionBuffer } from "./session-buffer.js";

// 代理连接状态，跟踪 ws、会话集合、宽限期定时器
interface ProxyState {
  ws: WebSocket | null;
  sessions: Set<string>;
  graceTimer: NodeJS.Timeout | null;
  disconnectedAt: number | null;
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

  // 旧版兼容：WebSocket -> proxyId 的反向映射
  private legacyClientBindings = new Map<WebSocket, string>();

  registerProxy(proxyId: string, ws: WebSocket): "new" | "reconnected" {
    const existing = this.proxyStates.get(proxyId);
    if (existing) {
      // 取消宽限期定时器
      if (existing.graceTimer) {
        clearTimeout(existing.graceTimer);
        existing.graceTimer = null;
      }
      // 如果旧连接还活着，先终止
      if (existing.ws && existing.ws.readyState === WebSocket.OPEN) {
        existing.ws.terminate();
      }
      existing.ws = ws;
      existing.disconnectedAt = null;
      return "reconnected";
    }

    this.proxyStates.set(proxyId, {
      ws,
      sessions: new Set(),
      graceTimer: null,
      disconnectedAt: null,
    });
    return "new";
  }

  // 启动宽限期，proxy 断连后保留状态等待重连
  startGracePeriod(proxyId: string, timeoutMs = 1800000): void {
    const state = this.proxyStates.get(proxyId);
    if (!state) return;

    state.ws = null;
    state.disconnectedAt = Date.now();

    if (state.graceTimer) {
      clearTimeout(state.graceTimer);
    }

    state.graceTimer = setTimeout(() => {
      // 竞态保护：确认 ws 仍为 null（重连可能已恢复）
      const current = this.proxyStates.get(proxyId);
      if (current && current.ws === null) {
        this.cleanupProxy(proxyId);
      }
    }, timeoutMs);

    // 不阻止进程退出
    state.graceTimer.unref();
  }

  // 彻底清理 proxy 状态、会话缓冲区、客户端绑定
  cleanupProxy(proxyId: string): void {
    const state = this.proxyStates.get(proxyId);
    if (!state) return;

    if (state.graceTimer) {
      clearTimeout(state.graceTimer);
    }

    // 清理该 proxy 拥有的所有会话缓冲区
    for (const sessionId of state.sessions) {
      this.sessionBuffers.delete(sessionId);
    }

    // 解绑所有绑定到该 proxy 的客户端
    for (const [clientId, binding] of this.clientBindings) {
      if (binding.proxyId === proxyId) {
        this.clientBindings.delete(clientId);
      }
    }

    // 清理旧版客户端绑定
    for (const [clientWs, boundProxyId] of this.legacyClientBindings) {
      if (boundProxyId === proxyId) {
        this.legacyClientBindings.delete(clientWs);
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

  // 将 sessionId 关联到 proxy
  addSessionToProxy(proxyId: string, sessionId: string): void {
    const state = this.proxyStates.get(proxyId);
    if (state) {
      state.sessions.add(sessionId);
    }
  }

  getOrCreateSessionBuffer(sessionId: string): SessionBuffer {
    let buffer = this.sessionBuffers.get(sessionId);
    if (!buffer) {
      buffer = new SessionBuffer();
      this.sessionBuffers.set(sessionId, buffer);
    }
    return buffer;
  }

  getSessionBuffer(sessionId: string): SessionBuffer | undefined {
    return this.sessionBuffers.get(sessionId);
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

  unbindClientById(clientId: string): void {
    this.clientBindings.delete(clientId);
  }

  getClientBinding(clientId: string): ClientBinding | undefined {
    return this.clientBindings.get(clientId);
  }

  // 旧版 WebSocket 引用绑定方式，保持向后兼容
  bindClient(clientWs: WebSocket, proxyId: string): boolean {
    if (!this.proxyStates.has(proxyId)) {
      return false;
    }
    this.legacyClientBindings.set(clientWs, proxyId);
    return true;
  }

  unbindClient(clientWs: WebSocket): void {
    this.legacyClientBindings.delete(clientWs);
  }

  getBoundProxy(clientWs: WebSocket): string | undefined {
    return this.legacyClientBindings.get(clientWs);
  }

  // 获取绑定到指定 proxy 的所有活跃客户端 WebSocket
  getClientsForProxy(proxyId: string): WebSocket[] {
    const clients: WebSocket[] = [];

    // clientId 绑定的客户端
    for (const [, binding] of this.clientBindings) {
      if (binding.proxyId === proxyId && binding.ws && binding.ws.readyState === WebSocket.OPEN) {
        clients.push(binding.ws);
      }
    }

    // 旧版 WebSocket 绑定的客户端
    for (const [clientWs, boundProxyId] of this.legacyClientBindings) {
      if (boundProxyId === proxyId && clientWs.readyState === WebSocket.OPEN) {
        clients.push(clientWs);
      }
    }

    return clients;
  }

  countClients(): number {
    let count = 0;
    for (const [, binding] of this.clientBindings) {
      if (binding.ws) count++;
    }
    count += this.legacyClientBindings.size;
    return count;
  }

  // 取消所有宽限期定时器，服务器关闭时调用
  clearAllTimers(): void {
    for (const [, state] of this.proxyStates) {
      if (state.graceTimer) {
        clearTimeout(state.graceTimer);
        state.graceTimer = null;
      }
    }
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
