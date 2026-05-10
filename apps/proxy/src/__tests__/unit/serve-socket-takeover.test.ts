import { describe, expect, it, vi } from "vitest";
import type { Socket } from "node:net";
import { takeoverServeSocket } from "../../worker/serve-socket-takeover.js";

function fakeSocket(): Socket & { destroyCalls: number } {
  const sock = {
    destroyCalls: 0,
    destroy: vi.fn(function (this: { destroyCalls: number }) {
      this.destroyCalls++;
    }),
  } as unknown as Socket & { destroyCalls: number };
  return sock;
}

describe("takeoverServeSocket", () => {
  it("destroys the previous socket when a new one arrives", () => {
    const prev = fakeSocket();
    const next = fakeSocket();
    const result = takeoverServeSocket(prev, next);
    expect(result).toBe(next);
    expect(prev.destroyCalls).toBe(1);
    expect(next.destroyCalls).toBe(0);
  });

  it("does not destroy when prev is null (first connection)", () => {
    const next = fakeSocket();
    const result = takeoverServeSocket(null, next);
    expect(result).toBe(next);
    expect(next.destroyCalls).toBe(0);
  });

  it("does not destroy when prev and next are the same instance (defensive no-op)", () => {
    const sock = fakeSocket();
    const result = takeoverServeSocket(sock, sock);
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
    expect(() => takeoverServeSocket(prev, next)).not.toThrow();
    expect(prev.destroy).toHaveBeenCalledTimes(1);
  });
});
