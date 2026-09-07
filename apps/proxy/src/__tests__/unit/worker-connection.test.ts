import { afterEach, describe, expect, it, vi } from "vitest";
import { Socket } from "node:net";
import {
  acceptCurrentWorkerSocketMessage,
  readWorkerConnection,
  releaseWorkerSocket,
  takeoverWorkerSocket,
} from "#src/ipc/worker-connection.js";

type ProbeMessage =
  | { tag: "greeting"; instance: string; generation: number }
  | { tag: "job"; value: number };

const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function connection() {
  vi.useFakeTimers();
  const socket = new Socket();
  sockets.push(socket);
  let receive!: (message: ProbeMessage) => void;
  let reject!: (error: Error) => void;
  const onAccepted = vi.fn();
  const onMessage = vi.fn();
  const onError = vi.fn();
  const read = vi.fn((_socket: Socket, onData: typeof receive, onInvalid: typeof reject) => {
    receive = onData;
    reject = onInvalid;
  });
  readWorkerConnection<ProbeMessage>(socket, {
    read,
    isHello: (message) => message.tag === "greeting",
    acceptHello: (message) =>
      message.tag === "greeting" && message.instance === "fixture" && message.generation === 7,
    onAccepted,
    onMessage,
    onError,
    timeoutMs: 50,
  });
  return { socket, read, receive, reject, onAccepted, onMessage, onError };
}

const greeting: ProbeMessage = { tag: "greeting", instance: "fixture", generation: 7 };
const job: ProbeMessage = { tag: "job", value: 42 };

describe("readWorkerConnection", () => {
  it("stays silent and disconnects peers that never write a hello", () => {
    const peer = connection();
    expect(peer.read).toHaveBeenCalledWith(peer.socket, expect.any(Function), expect.any(Function));
    vi.advanceTimersByTime(49);
    expect(peer.socket.destroyed).toBe(false);
    expect(peer.onAccepted).not.toHaveBeenCalled();
    expect(peer.onMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(peer.socket.destroyed).toBe(true);
    peer.receive(greeting);
    expect(peer.onAccepted).not.toHaveBeenCalled();
  });

  it("uses the supplied protocol and routes business messages only after accepting its hello", () => {
    const peer = connection();
    peer.receive(greeting);
    expect(peer.onAccepted).toHaveBeenCalledExactlyOnceWith(greeting);
    expect(peer.onMessage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(peer.socket.destroyed).toBe(false);
    peer.receive(job);
    expect(peer.onMessage).toHaveBeenCalledExactlyOnceWith(job);
  });

  it.each<ProbeMessage>([
    job,
    { tag: "greeting", instance: "other", generation: 7 },
    { tag: "greeting", instance: "fixture", generation: 8 },
  ])("rejects invalid first messages without accepting subsequent buffered hello: %j", (first) => {
    const peer = connection();
    peer.receive(first);
    peer.receive(greeting);
    peer.receive(job);
    expect(peer.socket.destroyed).toBe(true);
    expect(peer.onAccepted).not.toHaveBeenCalled();
    expect(peer.onMessage).not.toHaveBeenCalled();
    expect(peer.onError).toHaveBeenCalledTimes(1);
  });

  it("rejects a second hello, including one with a different identity", () => {
    const peer = connection();
    peer.receive(greeting);
    peer.receive({ tag: "greeting", instance: "other", generation: 7 });
    peer.receive(job);
    expect(peer.onAccepted).toHaveBeenCalledTimes(1);
    expect(peer.onMessage).not.toHaveBeenCalled();
    expect(peer.onError).toHaveBeenCalledTimes(1);
    expect(peer.socket.destroyed).toBe(true);
  });

  it("rejects parse errors before admission but only reports malformed business messages", () => {
    const invalid = connection();
    const parseError = new Error("Invalid protocol frame");
    invalid.reject(parseError);
    invalid.receive(greeting);
    expect(invalid.socket.destroyed).toBe(true);
    expect(invalid.onAccepted).not.toHaveBeenCalled();
    expect(invalid.onError).toHaveBeenCalledExactlyOnceWith(parseError);

    const accepted = connection();
    accepted.receive(greeting);
    accepted.reject(parseError);
    accepted.receive(job);
    expect(accepted.socket.destroyed).toBe(false);
    expect(accepted.onError).toHaveBeenCalledExactlyOnceWith(parseError);
    expect(accepted.onMessage).toHaveBeenCalledExactlyOnceWith(job);
  });

  it("clears the pending handshake timer when the connection closes", () => {
    const peer = connection();
    expect(vi.getTimerCount()).toBe(1);
    peer.socket.emit("close");
    expect(vi.getTimerCount()).toBe(0);
  });
});

function fakeSocket(): Socket & { destroyCalls: number } {
  const sock = {
    destroyCalls: 0,
    destroy: vi.fn(function (this: { destroyCalls: number }) {
      this.destroyCalls++;
    }),
  } as unknown as Socket & { destroyCalls: number };
  return sock;
}

describe("takeoverWorkerSocket", () => {
  it("destroys the previous socket when a new one arrives", () => {
    const prev = fakeSocket();
    const next = fakeSocket();
    const result = takeoverWorkerSocket(prev, next);
    expect(result).toBe(next);
    expect(prev.destroyCalls).toBe(1);
    expect(next.destroyCalls).toBe(0);
  });

  it("does not destroy when prev is null (first connection)", () => {
    const next = fakeSocket();
    const result = takeoverWorkerSocket(null, next);
    expect(result).toBe(next);
    expect(next.destroyCalls).toBe(0);
  });

  it("does not destroy when prev and next are the same instance (defensive no-op)", () => {
    const sock = fakeSocket();
    const result = takeoverWorkerSocket(sock, sock);
    expect(result).toBe(sock);
    expect(sock.destroyCalls).toBe(0);
  });

  it("swallows errors from prev.destroy() so a half-closed socket cannot break takeover", () => {
    const prev = {
      destroy: vi.fn(() => {
        throw new Error("ENOTCONN");
      }),
    } as unknown as Socket;
    const next = fakeSocket();
    expect(() => takeoverWorkerSocket(prev, next)).not.toThrow();
    expect(prev.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("releaseWorkerSocket", () => {
  it("ignores a late close from the socket replaced during takeover", () => {
    const previous = fakeSocket();
    const current = fakeSocket();
    const onCurrentClosed = vi.fn();

    expect(releaseWorkerSocket(current, previous, onCurrentClosed)).toBe(current);
    expect(onCurrentClosed).not.toHaveBeenCalled();
  });

  it("clears state and runs cleanup when the current socket closes", () => {
    const current = fakeSocket();
    const onCurrentClosed = vi.fn();

    expect(releaseWorkerSocket(current, current, onCurrentClosed)).toBeNull();
    expect(onCurrentClosed).toHaveBeenCalledTimes(1);
  });
});

describe("acceptCurrentWorkerSocketMessage", () => {
  it("destroys a superseded socket before its buffered business message can run", () => {
    const previous = fakeSocket();
    const current = fakeSocket();
    const executeBusinessMessage = vi.fn();

    if (acceptCurrentWorkerSocketMessage(current, previous)) executeBusinessMessage();

    expect(executeBusinessMessage).not.toHaveBeenCalled();
    expect(previous.destroyCalls).toBe(1);
    expect(acceptCurrentWorkerSocketMessage(current, current)).toBe(true);
  });
});
