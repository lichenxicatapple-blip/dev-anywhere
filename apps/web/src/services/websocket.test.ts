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
});
