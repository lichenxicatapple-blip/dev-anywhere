import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { swapServeSocket } from "../../terminal/serve-socket-swap.js";

describe("swapServeSocket", () => {
  it("clears every listener on the prev socket and returns the next socket", () => {
    // 用真 EventEmitter 反映 reconnectToServe 的实际场景：旧 socket 上累积了
    // close/error/data + createIpcReader pipe 的 listener。
    const prev = new EventEmitter();
    prev.on("close", () => {});
    prev.on("error", () => {});
    prev.on("data", () => {});
    prev.on("data", () => {});
    expect(prev.listenerCount("close")).toBe(1);
    expect(prev.listenerCount("data")).toBe(2);

    const next = new EventEmitter();
    const result = swapServeSocket(prev as unknown as Socket, next as unknown as Socket);

    expect(result).toBe(next);
    // 关键：旧 socket 上每种事件的 listener 计数都归零，否则每次 reconnect 单调累积。
    expect(prev.listenerCount("close")).toBe(0);
    expect(prev.listenerCount("error")).toBe(0);
    expect(prev.listenerCount("data")).toBe(0);
  });

  it("does not touch listeners on the next socket", () => {
    const prev = new EventEmitter();
    const next = new EventEmitter();
    next.on("close", () => {});
    swapServeSocket(prev as unknown as Socket, next as unknown as Socket);
    expect(next.listenerCount("close")).toBe(1);
  });
});
