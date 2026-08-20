// WebSocket 连接管理器，使用原生 WebSocket，支持文本和二进制消息分发，指数退避重连

import { decodeBinaryFrame, RelayCloseCode } from "@dev-anywhere/shared";
import { describeCurrentClientDevice } from "@/lib/client-device";

type SendOptions = {
  queueWhenDisconnected?: boolean;
};

// 离线 pending 队列上限。proxy 端 MemoryMessageQueue 用同一数值。超过后丢弃最旧条目，
// 避免在长时间离线 + 连续 send 的场景下无限增长把 tab 内存吃光。
const MAX_PENDING_QUEUE_SIZE = 10000;
// 手机锁屏/切后台后，浏览器可能保留一个 readyState=OPEN、实际已被系统回收的半开连接。
// 短暂切应用不必额外验活；超过这个窗口则在恢复前台时验证现有连接。
const BACKGROUND_RECONNECT_THRESHOLD_MS = 5_000;
// 页面一直在前台时系统不会提供 visibility/focus 恢复信号；移动网络切换又可能让浏览器
// 永久保留 readyState=OPEN 的半开 socket。仅在连续无入站数据时发一个应用层 ping，健康
// 连接每 15 秒最多一次探测（请求/响应各一帧），活跃 PTY 则完全不增加流量。
const FOREGROUND_CONNECTION_IDLE_MS = 15_000;
// 浏览器 WebSocket API 不暴露协议层 ping。复用 Relay 的应用层 ping/pong，在这个窗口内
// 能收到任意入站帧就保留原连接；只有完全静默才承担完整换链与状态重建的成本。
const CONNECTION_PROBE_TIMEOUT_MS = 2_000;

interface WebSocketManagerOptions {
  probeConnectionAfterBackground?: boolean;
}

interface ConnectionProbe {
  socket: WebSocket;
  requestId: string;
  timeout: ReturnType<typeof setTimeout>;
}

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private url = "";
  private connected = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private messageHandlers = new Set<(data: string) => void>();
  private binarySubscribers = new Map<string, Set<(data: Uint8Array, outputSeq: number) => void>>();
  private statusHandlers = new Set<(connected: boolean) => void>();
  private pendingQueue: string[] = [];
  private wakeListenersAttached = false;
  private backgroundedAt: number | null = null;
  private connectionProbe: ConnectionProbe | null = null;
  private connectionProbeSeq = 0;
  private foregroundWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
  private lastInboundAt = 0;
  private readonly probeConnectionLiveness: boolean;
  // 命名引用让 close() 能 removeEventListener；匿名 lambda 注册到 document/window 上
  // 后无法摘除，instance 不会被 GC，长寿 tab 上 close → reconnect 反复后能堆积大量回调。
  private readonly visibilityListener = (): void => {
    if (document.visibilityState === "hidden") {
      this.markBackgrounded();
      return;
    }
    if (document.visibilityState === "visible") this.resumeFromBackground();
  };
  // `online` means the browser observed a route transition. The old socket may still report
  // OPEN or may be stuck CONNECTING forever, so this signal must replace rather than merely wake.
  private readonly onlineListener = (): void => this.wakeReconnect(true);
  private readonly blurListener = (): void => this.markBackgrounded();
  private readonly focusListener = (): void => {
    // Some Android Chrome builds emit only blur/focus when the whole activity is
    // backgrounded. If visibility is genuinely hidden, wait for its visible event.
    if (document.visibilityState !== "hidden") this.resumeFromBackground();
  };
  private readonly pageHideListener = (): void => this.markBackgrounded();
  private readonly pageShowListener = (): void => this.resumeFromBackground();

  constructor(options: WebSocketManagerOptions = {}) {
    const deviceKind = describeCurrentClientDevice().deviceKind;
    this.probeConnectionLiveness =
      options.probeConnectionAfterBackground ?? (deviceKind === "phone" || deviceKind === "tablet");
  }

  private markBackgrounded(): void {
    this.cancelConnectionProbe();
    this.cancelForegroundWatchdog();
    this.backgroundedAt ??= Date.now();
  }

  private resumeFromBackground(): void {
    const backgroundedAt = this.backgroundedAt;
    this.backgroundedAt = null;
    const wasBackgroundedLongEnough =
      backgroundedAt !== null && Date.now() - backgroundedAt >= BACKGROUND_RECONNECT_THRESHOLD_MS;
    if (this.probeConnectionLiveness && wasBackgroundedLongEnough) {
      this.probeConnection();
      return;
    }
    this.wakeReconnect();
    this.ensureForegroundWatchdog();
  }

  private cancelConnectionProbe(socket?: WebSocket): void {
    const probe = this.connectionProbe;
    if (!probe || (socket && probe.socket !== socket)) return;
    clearTimeout(probe.timeout);
    this.connectionProbe = null;
  }

  private cancelForegroundWatchdog(): void {
    if (!this.foregroundWatchdogTimer) return;
    clearTimeout(this.foregroundWatchdogTimer);
    this.foregroundWatchdogTimer = null;
  }

  private canRunForegroundWatchdog(): boolean {
    return (
      this.probeConnectionLiveness &&
      !this.closed &&
      this.backgroundedAt === null &&
      (typeof document === "undefined" || document.visibilityState !== "hidden")
    );
  }

  private armForegroundWatchdog(delay = FOREGROUND_CONNECTION_IDLE_MS): void {
    this.cancelForegroundWatchdog();
    if (!this.canRunForegroundWatchdog() || this.connectionProbe) return;
    this.foregroundWatchdogTimer = setTimeout(
      () => {
        this.foregroundWatchdogTimer = null;
        this.runForegroundWatchdog();
      },
      Math.max(0, delay),
    );
  }

  private ensureForegroundWatchdog(): void {
    if (this.foregroundWatchdogTimer || this.connectionProbe) return;
    this.armForegroundWatchdog();
  }

  private runForegroundWatchdog(): void {
    if (!this.canRunForegroundWatchdog()) return;
    const socket = this.ws;
    if (!socket || !this.connected || socket.readyState !== WebSocket.OPEN) {
      // Includes a CONNECTING attempt that never completes after a mobile route transition.
      this.wakeReconnect(true);
      return;
    }

    const idleFor = Date.now() - this.lastInboundAt;
    if (idleFor < FOREGROUND_CONNECTION_IDLE_MS) {
      this.armForegroundWatchdog(FOREGROUND_CONNECTION_IDLE_MS - idleFor);
      return;
    }
    this.probeConnection();
  }

  private probeConnection(): void {
    if (this.closed) return;
    const socket = this.ws;
    if (!this.connected || !socket || socket.readyState !== WebSocket.OPEN) {
      // 没有可验证的 OPEN 连接。长后台可能冻结了 CONNECTING 尝试，直接换链恢复。
      this.wakeReconnect(true);
      return;
    }

    this.cancelConnectionProbe();
    this.cancelForegroundWatchdog();
    this.connectionProbeSeq += 1;
    const requestId = `connection-liveness-${Date.now().toString(36)}-${this.connectionProbeSeq.toString(36)}`;
    const timeout = setTimeout(() => {
      const active = this.connectionProbe;
      if (!active || active.socket !== socket || active.requestId !== requestId) return;
      this.connectionProbe = null;
      if (this.ws !== socket || this.closed) return;
      this.wakeReconnect(true);
    }, CONNECTION_PROBE_TIMEOUT_MS);
    this.connectionProbe = { socket, requestId, timeout };

    try {
      // WebSocketManager 只消费自己 requestId 对应的 pong；其他 Relay 消息仍按原路径分发。
      socket.send(JSON.stringify({ type: "latency_web_relay_ping", requestId }));
    } catch {
      this.cancelConnectionProbe(socket);
      if (this.ws === socket && !this.closed) this.wakeReconnect(true);
    }
  }

  private consumeConnectionProbePong(socket: WebSocket, data: string): boolean {
    const probe = this.connectionProbe;
    if (!probe || probe.socket !== socket) return false;

    let message: { type?: unknown; requestId?: unknown };
    try {
      message = JSON.parse(data) as { type?: unknown; requestId?: unknown };
    } catch {
      return false;
    }
    if (message.type !== "latency_web_relay_pong" || message.requestId !== probe.requestId) {
      return false;
    }

    this.cancelConnectionProbe(socket);
    return true;
  }

  private noteInbound(socket: WebSocket): void {
    if (this.ws !== socket) return;
    this.lastInboundAt = Date.now();
    // A normal relay/PTY frame proves the route is alive just as strongly as our own pong.
    this.cancelConnectionProbe(socket);
    this.ensureForegroundWatchdog();
  }

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  connect(url: string): void {
    this.cancelConnectionProbe();
    this.cancelForegroundWatchdog();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.cancelReconnectTimer();
    this.connected = false;
    this.url = url;
    this.closed = false;
    this.reconnectAttempt = 0;
    this.attachWakeListeners();
    this.doConnect();
  }

  // 页面从后台/锁屏回来、网络从离线恢复，立即触发重连，避免等退避定时器
  private attachWakeListeners(): void {
    if (this.wakeListenersAttached || typeof window === "undefined") return;
    this.wakeListenersAttached = true;
    document.addEventListener("visibilitychange", this.visibilityListener);
    window.addEventListener("online", this.onlineListener);
    window.addEventListener("blur", this.blurListener);
    window.addEventListener("focus", this.focusListener);
    window.addEventListener("pagehide", this.pageHideListener);
    window.addEventListener("pageshow", this.pageShowListener);
  }

  private detachWakeListeners(): void {
    if (!this.wakeListenersAttached || typeof window === "undefined") return;
    this.wakeListenersAttached = false;
    document.removeEventListener("visibilitychange", this.visibilityListener);
    window.removeEventListener("online", this.onlineListener);
    window.removeEventListener("blur", this.blurListener);
    window.removeEventListener("focus", this.focusListener);
    window.removeEventListener("pagehide", this.pageHideListener);
    window.removeEventListener("pageshow", this.pageShowListener);
  }

  private wakeReconnect(force = false): void {
    if (this.closed || (!force && this.connected)) return;
    // 老 ws 还在 CONNECTING: 不打断它, 浏览器会输出 "WebSocket is closed before
    // the connection is established" 警告且新建一份会跟它 race, stale 事件互相
    // 覆盖 this.ws 直到出 InvalidStateError CONNECTING。等它自己 OPEN 或 close。
    if (!force && this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    this.cancelConnectionProbe();
    this.cancelForegroundWatchdog();
    // 锁屏期间的失败次数不应该惩罚恢复后的第一次重连
    this.reconnectAttempt = 0;
    this.cancelReconnectTimer();
    // 老 ws 可能处于 half-open（TCP 半死），显式 close 再立即重连
    const previousWs = this.ws;
    const wasConnected = this.connected;
    // 先摘掉 active 引用，previousWs.close() 同步/异步触发的 close 都会被 stale guard 忽略。
    this.ws = null;
    this.connected = false;
    if (wasConnected) this.statusHandlers.forEach((handler) => handler(false));
    if (previousWs) {
      try {
        previousWs.close();
      } catch {
        // 已死的 ws close 可能抛，忽略
      }
    }
    this.doConnect();
  }

  send(data: string, options: SendOptions = {}): boolean {
    if (!this.ws) {
      console.warn("WebSocket send dropped: no socket");
      return false;
    }
    if (!this.connected) {
      if (options.queueWhenDisconnected) {
        if (this.pendingQueue.length >= MAX_PENDING_QUEUE_SIZE) {
          const dropped = this.pendingQueue.shift();
          console.warn(
            "WebSocket queue overflow: dropping oldest pending message",
            dropped?.slice(0, 200),
          );
        }
        this.pendingQueue.push(data);
      }
      return false;
    }
    this.doSend(data);
    return true;
  }

  close(): void {
    this.closed = true;
    this.cancelConnectionProbe();
    this.cancelForegroundWatchdog();
    this.cancelReconnectTimer();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.backgroundedAt = null;
    this.detachWakeListeners();
  }

  onMessage(handler: (data: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: (connected: boolean) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  subscribeBinary(
    sessionId: string,
    handler: (data: Uint8Array, outputSeq: number) => void,
  ): () => void {
    let subscribers = this.binarySubscribers.get(sessionId);
    if (!subscribers) {
      subscribers = new Set();
      this.binarySubscribers.set(sessionId, subscribers);
    }
    subscribers.add(handler);
    return () => {
      subscribers!.delete(handler);
      if (subscribers!.size === 0) {
        this.binarySubscribers.delete(sessionId);
      }
    };
  }

  private doConnect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    // Also bounds a CONNECTING socket which never produces open/close after a route change.
    this.armForegroundWatchdog();

    // wakeReconnect / connect() 重新建链时, 老 ws 的 close / open 事件可能在新 ws
    // 已替换 this.ws 之后才异步 fire (尤其老 ws 是 CONNECTING 被 close 时)。所有
    // listener 都用 ws !== this.ws 早返, 避免 stale 事件污染 this.connected /
    // this.ws / 触发额外 reconnect 导致多 ws 互相覆盖, 最终 status handler 拿到
    // 错位的 connected 状态调 send 撞上 CONNECTING ws → InvalidStateError。
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.reconnectAttempt = 0;
      this.lastInboundAt = Date.now();
      this.armForegroundWatchdog();
      this.statusHandlers.forEach((h) => h(true));
      this.flushPendingQueue();
    });

    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        this.noteInbound(ws);
        this.dispatchBinary(new Uint8Array(event.data));
      } else {
        const data = event.data as string;
        const isProbePong = this.consumeConnectionProbePong(ws, data);
        this.noteInbound(ws);
        if (isProbePong) return;
        this.messageHandlers.forEach((h) => h(data));
      }
    });

    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.cancelConnectionProbe(ws);
      this.cancelForegroundWatchdog();
      if (event.code === RelayCloseCode.CLIENT_KICKED) {
        this.closed = true;
        this.cancelReconnectTimer();
      }
      this.connected = false;
      this.ws = null;
      this.statusHandlers.forEach((h) => h(false));
      if (!this.closed) this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // close event follows, no action needed
    });
  }

  private scheduleReconnect(): void {
    // Full Jitter 指数退避，和 proxy 侧一致：避免多 client 同步重连打崩 relay
    const cap = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000);
    const delay = Math.random() * cap;
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private dispatchBinary(view: Uint8Array): void {
    const decoded = decodeBinaryFrame(view);
    if (!decoded) return;
    const subscribers = this.binarySubscribers.get(decoded.sessionId);
    if (subscribers) {
      subscribers.forEach((h) => h(decoded.data, decoded.outputSeq));
    }
  }

  private doSend(data: string): void {
    this.ws?.send(data);
  }

  private flushPendingQueue(): void {
    const queue = this.pendingQueue.splice(0);
    for (const data of queue) {
      this.doSend(data);
    }
  }
}
