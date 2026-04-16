// WebSocket 连接管理器，使用原生 WebSocket，支持文本和二进制消息分发，指数退避重连

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private url = "";
  private connected = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private messageHandlers = new Set<(data: string) => void>();
  private binarySubscribers = new Map<string, Set<(data: Uint8Array) => void>>();
  private statusHandlers = new Set<(connected: boolean) => void>();
  private pendingQueue: string[] = [];

  connect(url: string): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    this.url = url;
    this.closed = false;
    this.reconnectAttempt = 0;
    this.doConnect();
  }

  send(data: string): boolean {
    if (!this.ws) {
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

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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

  subscribeBinary(sessionId: string, handler: (data: Uint8Array) => void): () => void {
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
      this.flushPendingQueue();
      this.statusHandlers.forEach((h) => h(true));
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
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt), 30000);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private dispatchBinary(view: Uint8Array): void {
    if (view.length < 2) return;
    const sidLen = view[0];
    if (view.length < 1 + sidLen) return;
    const sessionId = new TextDecoder().decode(view.subarray(1, 1 + sidLen));
    const ptyData = view.subarray(1 + sidLen);
    const subscribers = this.binarySubscribers.get(sessionId);
    if (subscribers) {
      subscribers.forEach((h) => h(ptyData));
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
