import { WebSocket } from "ws";
import { defineFSM } from "@dev-anywhere/shared";

// 显式代理连接状态，取代 ws null 检查
type ProxyConnectionState = "online" | "offline";

// 显式客户端连接状态，跟踪注册和绑定
type ClientConnectionState = "registered" | "bound";

// proxy 连接 FSM: 仅 online <-> offline 双向流转。registerProxy 走 reconnect 路径直接写
// online (相当于 offline -> online), transitionProxy 走 close 路径走 online -> offline。
// 同状态停留 (online -> online / offline -> offline) 视为非法, 由 canTransition 拦下。
const proxyConnectionFSM = defineFSM<ProxyConnectionState>({
  online: ["offline"],
  offline: ["online"],
});

// 代理连接状态，跟踪 ws、会话集合、离线时间、显示名称
interface ProxyState {
  ws: WebSocket | null;
  connectionState: ProxyConnectionState;
  sessions: Set<string>;
  disconnectedAt: number | null;
  name?: string;
}

// 客户端绑定状态，通过 clientId 而非 WebSocket 引用标识
interface ClientBinding {
  proxyId: string;
  ws: WebSocket | null;
  connectionState: ClientConnectionState;
}

// 代理注册、客户端绑定、宽限期管理
export class RelayRegistry {
  private proxyStates = new Map<string, ProxyState>();
  private clientBindings = new Map<string, ClientBinding>();
  private connectedClients = new Set<WebSocket>();

  registerProxy(proxyId: string, ws: WebSocket, name?: string): "new" | "reconnected" {
    const existing = this.proxyStates.get(proxyId);
    if (existing) {
      // 如果旧连接还活着，先终止
      if (existing.ws && existing.ws.readyState === WebSocket.OPEN) {
        existing.ws.terminate();
      }
      existing.ws = ws;
      existing.connectionState = "online";
      existing.disconnectedAt = null;
      if (name !== undefined) existing.name = name;
      return "reconnected";
    }

    this.proxyStates.set(proxyId, {
      ws,
      connectionState: "online",
      sessions: new Set(),
      disconnectedAt: null,
      name,
    });
    return "new";
  }

  // 显式状态转换，校验 from 状态匹配后更新 connectionState
  transitionProxy(proxyId: string, from: ProxyConnectionState, to: ProxyConnectionState): void {
    if (!proxyConnectionFSM.canTransition(from, to)) {
      throw new Error(`Invalid proxy transition: ${from} -> ${to}`);
    }
    const state = this.proxyStates.get(proxyId);
    if (!state) {
      throw new Error(`Proxy not found: ${proxyId}`);
    }
    if (state.connectionState !== from) {
      throw new Error(
        `Proxy ${proxyId} state mismatch: expected ${from}, actual ${state.connectionState}`,
      );
    }
    state.connectionState = to;
    if (to === "offline") {
      state.ws = null;
      state.disconnectedAt = Date.now();
    }
  }

  getProxyConnectionState(proxyId: string): ProxyConnectionState | undefined {
    return this.proxyStates.get(proxyId)?.connectionState;
  }

  getClientConnectionState(clientId: string): ClientConnectionState | undefined {
    return this.clientBindings.get(clientId)?.connectionState;
  }

  // 彻底清理 proxy 状态和客户端绑定
  cleanupProxy(proxyId: string): void {
    const state = this.proxyStates.get(proxyId);
    if (!state) return;

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
    if (!state || state.connectionState !== "online") return false;
    // connectionState 声明在线但 ws 已失效时，记录警告并返回 false
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return false;
    return true;
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
      online: state.connectionState === "online",
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

  // 通过 sessionId 反查所属 proxyId
  getProxyForSession(sessionId: string): string | undefined {
    for (const [proxyId, state] of this.proxyStates) {
      if (state.sessions.has(sessionId)) {
        return proxyId;
      }
    }
    return undefined;
  }

  // 获取 proxy 关联的所有 sessionId
  getSessionsForProxy(proxyId: string): string[] {
    const state = this.proxyStates.get(proxyId);
    return state ? Array.from(state.sessions) : [];
  }

  // clientId 绑定方式
  bindClientById(clientId: string, proxyId: string, ws: WebSocket): boolean {
    if (!this.proxyStates.has(proxyId)) {
      return false;
    }
    this.clientBindings.set(clientId, { proxyId, ws, connectionState: "bound" });
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
    // 计数依据：ws 还存活且处于 OPEN。仅 `if (binding.ws)` 不够：close handler 漏调
    // unbindClientById 时 ws 对象残留，会让 /status 永久报告虚高 clientCount。
    let count = 0;
    for (const [, binding] of this.clientBindings) {
      if (binding.ws && binding.ws.readyState === WebSocket.OPEN) count++;
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

  // 获取单个 proxy 的详细状态信息
  getProxyDetail(proxyId: string):
    | {
        proxyId: string;
        name?: string;
        online: boolean;
        connectionState: ProxyConnectionState;
        sessions: string[];
        disconnectedAt: number | null;
      }
    | undefined {
    const state = this.proxyStates.get(proxyId);
    if (!state) return undefined;
    return {
      proxyId,
      ...(state.name !== undefined ? { name: state.name } : {}),
      online: state.connectionState === "online",
      connectionState: state.connectionState,
      sessions: Array.from(state.sessions),
      disconnectedAt: state.disconnectedAt,
    };
  }

  // 获取所有客户端绑定的详细信息
  getClientDetails(): Array<{
    clientId: string;
    proxyId: string;
    online: boolean;
    connectionState: ClientConnectionState;
  }> {
    const details: Array<{
      clientId: string;
      proxyId: string;
      online: boolean;
      connectionState: ClientConnectionState;
    }> = [];
    for (const [clientId, binding] of this.clientBindings) {
      details.push({
        clientId,
        proxyId: binding.proxyId,
        online:
          binding.ws !== null &&
          binding.ws !== undefined &&
          binding.ws.readyState === WebSocket.OPEN,
        connectionState: binding.connectionState,
      });
    }
    return details;
  }
}
