// WebSocket 连接管理器，封装 Taro.connectSocket 并实现指数退避重连
import Taro from "@tarojs/taro";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

export class WebSocketManager {
  private task: Taro.SocketTask | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private url = "";
  private connected = false;
  private connecting = false;
  private messageHandlers = new Set<(data: string) => void>();
  private statusHandlers = new Set<(connected: boolean) => void>();
  private pendingQueue: string[] = [];

  connect(url: string): void {
    if (this.connecting && this.url === url) return;
    if (this.task) {
      this.task.close({});
      this.task = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    this.url = url;
    this.closed = false;
    this.doConnect();
  }

  private doConnect(): void {
    this.connecting = true;
    const result = Taro.connectSocket({ url: this.url });
    Promise.resolve(result).then((task) => {
      if (this.closed) {
        this.connecting = false;
        task.close({});
        return;
      }
      this.task = task;

      task.onOpen(() => {
        this.connecting = false;
        this.reconnectAttempt = 0;
        this.connected = true;
        this.flushPendingQueue();
        this.statusHandlers.forEach((h) => h(true));
      });

      task.onMessage((res) => {
        const data = typeof res.data === "string" ? res.data : "";
        if (!data) return;
        this.messageHandlers.forEach((h) => h(data));
      });

      task.onClose(() => {
        this.connecting = false;
        this.task = null;
        this.connected = false;
        this.statusHandlers.forEach((h) => h(false));
        if (!this.closed) this.scheduleReconnect();
      });

      task.onError(() => {
        // onError 通常后跟 onClose，不需要额外处理
      });
    });
  }

  private scheduleReconnect(): void {
    const backoff =
      Math.random() *
      Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempt++;
      this.doConnect();
    }, backoff);
  }

  send(data: string): boolean {
    if (!this.task) {
      console.warn("WebSocket send dropped: no socket");
      return false;
    }
    if (!this.connected) {
      this.pendingQueue.push(data);
      return false;
    }
    this.doSend(data);
    return true;
  }

  private doSend(data: string): void {
    if (!this.task) return;
    Promise.resolve(this.task.send({ data })).catch((err) => {
      console.error("WebSocket doSend failed:", err);
    });
  }

  private flushPendingQueue(): void {
    const queue = this.pendingQueue.splice(0);
    for (const data of queue) {
      this.doSend(data);
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.task?.close({});
    this.task = null;
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
}
