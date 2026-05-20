import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupHeartbeat } from "./heartbeat.js";

class MockSocket extends EventEmitter {
  isAlive?: boolean;
  ping = vi.fn();
  terminate = vi.fn();
}

class MockWebSocketServer extends EventEmitter {
  clients = new Set<MockSocket>();

  connect(socket: MockSocket): void {
    this.clients.add(socket);
    this.emit("connection", socket);
  }
}

describe("setupHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes new sockets so the first heartbeat pings instead of terminating them", () => {
    const server = new MockWebSocketServer();
    const socket = new MockSocket();

    const interval = setupHeartbeat(server as never, 1000);
    server.connect(socket);
    vi.advanceTimersByTime(1000);

    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.ping).toHaveBeenCalledTimes(1);
    clearInterval(interval);
  });

  it("marks a socket alive again when it receives pong", () => {
    const server = new MockWebSocketServer();
    const socket = new MockSocket();

    const interval = setupHeartbeat(server as never, 1000);
    server.connect(socket);
    vi.advanceTimersByTime(1000);
    socket.emit("pong");
    vi.advanceTimersByTime(1000);

    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.ping).toHaveBeenCalledTimes(2);
    clearInterval(interval);
  });
});
