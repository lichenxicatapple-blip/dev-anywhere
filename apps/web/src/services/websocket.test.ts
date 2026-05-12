import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketManager } from "./websocket";

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  binaryType: BinaryType = "arraybuffer";
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];

  constructor(readonly url: string) {
    super();
    sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
}

const sockets: FakeWebSocket[] = [];
const originalWebSocket = globalThis.WebSocket;

describe("WebSocketManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    sockets.length = 0;
    globalThis.WebSocket = originalWebSocket;
  });

  it("sends reconnect registration before flushing explicitly queued messages", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const manager = new WebSocketManager();
    manager.connect("ws://relay/client");

    expect(manager.send("request-that-must-not-queue")).toBe(false);
    expect(manager.send("queued-user-input", { queueWhenDisconnected: true })).toBe(false);
    manager.onStatusChange((connected) => {
      if (connected) manager.send("client-register");
    });

    sockets[0]?.open();

    expect(sockets[0]?.sent).toEqual(["client-register", "queued-user-input"]);
    manager.close();
  });

  it("ignores open / close events from a stale ws that survived a replacing reconnect", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const manager = new WebSocketManager();
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;

    // FakeWebSocket.close() 默认同步 dispatch close event; 现实里 close 一个 CONNECTING
    // ws 后浏览器会异步 fire close event, 跟下一个 ws 创建有 race。延迟到 microtask
    // 模拟这个异步性, 才能复现"老 ws close 在新 ws 已经替换 this.ws 之后才 fire"。
    let firePendingClose: (() => void) | null = null;
    ws1.close = function () {
      this.readyState = FakeWebSocket.CLOSED;
      firePendingClose = () => this.dispatchEvent(new Event("close"));
    };

    // 第二次 connect 等价 wakeReconnect: close 老 ws + 立即 doConnect 新 ws
    manager.connect("ws://relay/client");
    const ws2 = sockets[1]!;
    expect(ws2).not.toBe(ws1);

    let statusObserved: boolean | null = null;
    manager.onStatusChange((connected) => {
      statusObserved = connected;
      if (connected) manager.send("register");
    });

    // 触发 ws1 的 stale close: 老的 close listener 闭包持有 ws1, 但 this.ws 现在是
    // ws2。修前: 老 listener 把 this.ws=null + scheduleReconnect → 又创建 ws3, ws2
    // 之后 open 时 this.ws 已被覆盖, register 写到错误 ws (CONNECTING) → 线上
    // InvalidStateError。修后: stale guard 直接 return, ws2 仍是 active。
    firePendingClose!();
    expect(sockets.length).toBe(2);

    ws2.open();
    expect(statusObserved).toBe(true);
    expect(ws2.sent).toEqual(["register"]);

    manager.close();
  });

  it("does not abort a still-CONNECTING ws when wakeReconnect fires", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const manager = new WebSocketManager();
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    expect(ws1.readyState).toBe(FakeWebSocket.CONNECTING);

    // visibilitychange 在 ws1 还 CONNECTING 时触发 wakeReconnect: 旧实现会 close
    // 老 ws (浏览器输出 "closed before connection established") + 立即 doConnect。
    // 新实现检测 readyState=CONNECTING 时直接 return, 让 ws1 自己跑完。
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));

    // 仍然是 ws1, 没 close, 没创建 ws2。
    expect(sockets.length).toBe(1);
    expect(ws1.readyState).toBe(FakeWebSocket.CONNECTING);

    manager.close();
  });

  it("removes wake listeners on close so document/window do not retain the manager", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const docAdds: string[] = [];
    const docRemoves: string[] = [];
    const winAdds: string[] = [];
    const winRemoves: string[] = [];
    const docAdd = vi.spyOn(document, "addEventListener");
    const docRemove = vi.spyOn(document, "removeEventListener");
    const winAdd = vi.spyOn(window, "addEventListener");
    const winRemove = vi.spyOn(window, "removeEventListener");

    docAdd.mockImplementation((type: string) => {
      docAdds.push(type);
    });
    docRemove.mockImplementation((type: string) => {
      docRemoves.push(type);
    });
    winAdd.mockImplementation((type: string) => {
      winAdds.push(type);
    });
    winRemove.mockImplementation((type: string) => {
      winRemoves.push(type);
    });

    const manager = new WebSocketManager();
    manager.connect("ws://relay/client");

    expect(docAdds).toContain("visibilitychange");
    expect(winAdds).toEqual(expect.arrayContaining(["online", "focus"]));

    manager.close();

    // 每个被注册的 wake listener 在 close 时都该有一次匹配的 removeEventListener，
    // 否则 document/window 上残留匿名 lambda 引用，instance 永远拿不到 GC。
    expect(docRemoves).toContain("visibilitychange");
    expect(winRemoves).toEqual(expect.arrayContaining(["online", "focus"]));

    docAdd.mockRestore();
    docRemove.mockRestore();
    winAdd.mockRestore();
    winRemove.mockRestore();
  });
});
