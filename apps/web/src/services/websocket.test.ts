import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayCloseCode } from "@dev-anywhere/shared";
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

  closeWithCode(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close") as Event & { code: number };
    Object.defineProperty(event, "code", { value: code });
    this.dispatchEvent(event);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  receive(data: string): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  receiveBinary(data = new ArrayBuffer(0)): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
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

  it("replaces a half-open OPEN socket immediately when the browser reports online", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const manager = new WebSocketManager();
    const statuses: boolean[] = [];
    manager.onStatusChange((connected) => statuses.push(connected));
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    // The browser may keep a dead TCP path as readyState=OPEN throughout a signal outage.
    // `online` is the strongest available hint that the route changed, so keeping ws1 here
    // strands input on the old path even though the phone has network again.
    window.dispatchEvent(new Event("online"));

    expect(sockets).toHaveLength(2);
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSED);
    expect(statuses).toEqual([true, false]);
    sockets[1]!.open();
    expect(statuses).toEqual([true, false, true]);

    manager.close();
  });

  it("replaces a permanently CONNECTING socket when the browser reports online", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const manager = new WebSocketManager();
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    expect(ws1.readyState).toBe(FakeWebSocket.CONNECTING);

    window.dispatchEvent(new Event("online"));

    expect(sockets).toHaveLength(2);
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSED);
    expect(sockets[1]!.readyState).toBe(FakeWebSocket.CONNECTING);

    manager.close();
  });

  it("replaces a visible mobile OPEN socket when foreground ping receives no inbound data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    const statuses: boolean[] = [];
    manager.onStatusChange((connected) => statuses.push(connected));
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(ws1.sent).toHaveLength(1);
    expect(JSON.parse(ws1.sent[0]!)).toMatchObject({ type: "latency_web_relay_ping" });

    await vi.advanceTimersByTimeAsync(2_001);
    expect(sockets).toHaveLength(2);
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSED);
    expect(statuses).toEqual([true, false]);

    manager.close();
  });

  it("bounds a visible mobile socket that remains CONNECTING without open or close", async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sockets).toHaveLength(2);
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSED);
    expect(sockets[1]!.readyState).toBe(FakeWebSocket.CONNECTING);

    manager.close();
  });

  it("keeps a visible healthy mobile socket across repeated foreground probes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    const statuses: boolean[] = [];
    manager.onStatusChange((connected) => statuses.push(connected));
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    await vi.advanceTimersByTimeAsync(15_000);
    for (let probeIndex = 0; probeIndex < 2; probeIndex += 1) {
      const ping = JSON.parse(ws1.sent[probeIndex]!) as { requestId: string; type: string };
      expect(ping.type).toBe("latency_web_relay_ping");
      ws1.receive(JSON.stringify({ type: "latency_web_relay_pong", requestId: ping.requestId }));
      await vi.advanceTimersByTimeAsync(2_001);
      expect(sockets).toHaveLength(1);
      if (probeIndex === 0) await vi.advanceTimersByTimeAsync(12_999);
    }

    expect(ws1.readyState).toBe(FakeWebSocket.OPEN);
    expect(statuses).toEqual([true]);
    manager.close();
  });

  it("uses ordinary inbound traffic as foreground liveness without sending an early ping", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    const messages: string[] = [];
    manager.onMessage((message) => messages.push(message));
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    await vi.advanceTimersByTimeAsync(14_000);
    ws1.receive('{"type":"pty_state"}');
    await vi.advanceTimersByTimeAsync(14_999);

    expect(ws1.sent).toEqual([]);
    expect(messages).toEqual(['{"type":"pty_state"}']);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(ws1.sent[0]!)).toMatchObject({ type: "latency_web_relay_ping" });

    manager.close();
  });

  it("accepts an ordinary inbound frame instead of requiring the exact foreground pong", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(ws1.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    ws1.receive('{"type":"proxy_list_response"}');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sockets).toHaveLength(1);
    expect(ws1.readyState).toBe(FakeWebSocket.OPEN);
    manager.close();
  });

  it("uses binary PTY output as foreground liveness", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    await vi.advanceTimersByTimeAsync(14_000);
    ws1.receiveBinary();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(ws1.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(ws1.sent[0]!)).toMatchObject({ type: "latency_web_relay_ping" });

    manager.close();
  });

  it("does not run the foreground watchdog for desktop sockets", async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: false });
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(sockets).toHaveLength(1);
    expect(ws1.sent).toEqual([]);
    manager.close();
  });

  it("does not replace a healthy OPEN socket for ordinary visible/focus notifications", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));

    expect(sockets).toHaveLength(1);
    expect(ws1.readyState).toBe(FakeWebSocket.OPEN);
    expect(ws1.sent).toEqual([]);
    manager.close();
  });

  it("keeps an OPEN desktop socket after returning from a long background period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: false });
    const statuses: boolean[] = [];
    manager.onStatusChange((connected) => statuses.push(connected));
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_001);
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(sockets).toHaveLength(1);
    expect(ws1.readyState).toBe(FakeWebSocket.OPEN);
    expect(ws1.sent).toEqual([]);
    expect(statuses).toEqual([true]);

    manager.close();
  });

  it("keeps an OPEN mobile socket when the long-background liveness probe succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    const statuses: boolean[] = [];
    manager.onStatusChange((connected) => statuses.push(connected));
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_001);
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(sockets).toHaveLength(1);
    expect(ws1.readyState).toBe(FakeWebSocket.OPEN);
    expect(statuses).toEqual([true]);
    expect(ws1.sent).toHaveLength(1);
    const probe = JSON.parse(ws1.sent[0]!) as { type: string; requestId: string };
    expect(probe.type).toBe("latency_web_relay_ping");

    ws1.receive(JSON.stringify({ type: "latency_web_relay_pong", requestId: probe.requestId }));
    await vi.advanceTimersByTimeAsync(2_001);

    expect(sockets).toHaveLength(1);
    expect(ws1.readyState).toBe(FakeWebSocket.OPEN);
    expect(statuses).toEqual([true]);

    manager.close();
  });

  it("probes after a long mobile window blur when Android keeps visibilityState visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    window.dispatchEvent(new Event("blur"));
    await vi.advanceTimersByTimeAsync(5_001);
    window.dispatchEvent(new Event("focus"));

    expect(sockets).toHaveLength(1);
    expect(ws1.sent).toHaveLength(1);
    const probe = JSON.parse(ws1.sent[0]!) as { type: string; requestId: string };
    expect(probe.type).toBe("latency_web_relay_ping");

    ws1.receive(JSON.stringify({ type: "latency_web_relay_pong", requestId: probe.requestId }));
    await vi.advanceTimersByTimeAsync(2_001);
    expect(sockets).toHaveLength(1);
    expect(ws1.readyState).toBe(FakeWebSocket.OPEN);

    manager.close();
  });

  it("replaces an OPEN mobile socket when the long-background liveness probe times out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    const statuses: boolean[] = [];
    manager.onStatusChange((connected) => statuses.push(connected));
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_001);
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(sockets).toHaveLength(1);
    expect(ws1.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_001);

    expect(sockets).toHaveLength(2);
    expect(ws1.readyState).toBe(FakeWebSocket.CLOSED);
    expect(statuses).toEqual([true, false]);
    sockets[1]!.open();
    expect(statuses).toEqual([true, false, true]);

    manager.close();
  });

  it("does not probe or replace a mobile socket after a short background period", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(4_999);
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));

    expect(sockets).toHaveLength(1);
    expect(ws1.readyState).toBe(FakeWebSocket.OPEN);
    expect(ws1.sent).toEqual([]);

    manager.close();
  });

  it("cancels a pending background probe when the socket closes on its own", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T00:00:00Z"));
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    const manager = new WebSocketManager({ probeConnectionAfterBackground: true });
    manager.connect("ws://relay/client");
    const ws1 = sockets[0]!;
    ws1.open();

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_001);
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(ws1.sent).toHaveLength(1);

    ws1.close();
    await vi.advanceTimersByTimeAsync(1_001);
    expect(sockets).toHaveLength(2);

    // The old 2-second probe timeout must not replace the reconnect attempt a second time.
    await vi.advanceTimersByTimeAsync(2_001);
    expect(sockets).toHaveLength(2);

    manager.close();
  });

  it("does not reconnect after the relay kicks this client", async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const manager = new WebSocketManager();
    manager.connect("ws://relay/client");
    const ws = sockets[0]!;
    ws.open();

    ws.closeWithCode(RelayCloseCode.CLIENT_KICKED);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(sockets).toHaveLength(1);
    expect(manager.isConnected()).toBe(false);
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
    expect(winAdds).toEqual(
      expect.arrayContaining(["online", "blur", "focus", "pagehide", "pageshow"]),
    );

    manager.close();

    // 每个被注册的 wake listener 在 close 时都该有一次匹配的 removeEventListener，
    // 否则 document/window 上残留匿名 lambda 引用，instance 永远拿不到 GC。
    expect(docRemoves).toContain("visibilitychange");
    expect(winRemoves).toEqual(
      expect.arrayContaining(["online", "blur", "focus", "pagehide", "pageshow"]),
    );

    docAdd.mockRestore();
    docRemove.mockRestore();
    winAdd.mockRestore();
    winRemove.mockRestore();
  });
});
