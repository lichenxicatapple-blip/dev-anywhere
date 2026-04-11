// WebSocket 连接管理器，封装 Taro.connectSocket 并实现指数退避重连
//
// H5 模式下直接使用原生 WebSocket 而非 Taro.connectSocket polyfill。
// Taro 的 SocketTask 在构造函数中立即创建 WebSocket 连接，但 onOpen/onMessage
// 等事件处理器要等 Promise resolve 后才注册（通过 ws.onopen = func 赋值）。
// 对于 localhost 等低延迟连接，onopen 事件在 handler 注册前就已触发，导致事件丢失。
import Taro from "@tarojs/taro";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

const IS_H5 = process.env.TARO_ENV === "h5";

interface TaskLike {
  onOpen(cb: () => void): void;
  onMessage(cb: (res: { data: string }) => void): void;
  onClose(cb: () => void): void;
  onError(cb: () => void): void;
  send(opts: { data: string }): void | Promise<unknown>;
  close(opts: Record<string, unknown>): void;
}

// H5 模式下用原生 WebSocket 构造一个与 Taro SocketTask 接口兼容的适配对象。
// 关键区别：先注册事件处理器，再由调用方触发连接（事件处理器在 WebSocket 构造后同步设置）。
function createNativeTask(url: string): TaskLike {
  const ws = new WebSocket(url);
  return {
    onOpen(cb: () => void) {
      ws.addEventListener("open", cb);
    },
    onMessage(cb: (res: { data: string }) => void) {
      ws.addEventListener("message", (e) => {
        cb({ data: typeof e.data === "string" ? e.data : "" });
      });
    },
    onClose(cb: () => void) {
      ws.addEventListener("close", cb);
    },
    onError(cb: () => void) {
      ws.addEventListener("error", cb);
    },
    send(opts: { data: string }) {
      if (ws.readyState !== WebSocket.OPEN) {
        const err = { errMsg: "send:fail WebSocket is not open" };
        console.error(err.errMsg);
        return Promise.reject(err);
      }
      ws.send(opts.data);
      return Promise.resolve();
    },
    close() {
      ws.close();
    },
  };
}

export class WebSocketManager {
  private task: TaskLike | null = null;
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

    if (IS_H5) {
      this.setupNativeTask();
      return;
    }

    const result = Taro.connectSocket({ url: this.url });
    Promise.resolve(result)
      .then((task) => {
        if (this.closed) {
          this.connecting = false;
          task.close({});
          return;
        }
        this.task = task as unknown as TaskLike;
        this.bindTaskEvents(this.task);
      })
      .catch((err) => {
        console.error("Taro.connectSocket failed:", err);
        this.connecting = false;
        if (!this.closed) this.scheduleReconnect();
      });
  }

  // H5: 使用原生 WebSocket，先注册事件再让浏览器异步触发
  private setupNativeTask(): void {
    try {
      const task = createNativeTask(this.url);
      if (this.closed) {
        this.connecting = false;
        task.close({});
        return;
      }
      this.task = task;
      this.bindTaskEvents(task);
    } catch (err) {
      console.error("Native WebSocket creation failed:", err);
      this.connecting = false;
      if (!this.closed) this.scheduleReconnect();
    }
  }

  private bindTaskEvents(task: TaskLike): void {
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
