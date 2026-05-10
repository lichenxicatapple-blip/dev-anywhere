// WebSocket 连接管理器，使用原生 WebSocket，支持文本和二进制消息分发，指数退避重连

import { decodeBinaryFrame } from "@dev-anywhere/shared";

type SendOptions = {
  queueWhenDisconnected?: boolean;
};

// 离线 pending 队列上限。proxy 端 MemoryMessageQueue 用同一数值。超过后丢弃最旧条目，
// 避免在长时间离线 + 连续 send 的场景下无限增长把 tab 内存吃光。
const MAX_PENDING_QUEUE_SIZE = 10000;

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

  private cancelReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  connect(url: string): void {
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
    const wake = (): void => this.wakeReconnect();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") wake();
    });
    window.addEventListener("online", wake);
    window.addEventListener("focus", wake);
  }

  private wakeReconnect(): void {
    if (this.closed || this.connected) return;
    // 锁屏期间的失败次数不应该惩罚恢复后的第一次重连
    this.reconnectAttempt = 0;
    this.cancelReconnectTimer();
    // 老 ws 可能处于 half-open（TCP 半死），显式 close 再立即重连
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // 已死的 ws close 可能抛，忽略
      }
      this.ws = null;
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
    this.cancelReconnectTimer();
    this.ws?.close();
    this.ws = null;
    this.connected = false;
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

    ws.addEventListener("open", () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this.statusHandlers.forEach((h) => h(true));
      this.flushPendingQueue();
    });

    ws.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.dispatchBinary(new Uint8Array(event.data));
      } else {
        const data = event.data as string;
        this.messageHandlers.forEach((h) => h(data));
      }
    });

    ws.addEventListener("close", () => {
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
