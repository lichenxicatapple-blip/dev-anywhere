import { describe, it, expect } from "vitest";
import { MemoryMessageQueue } from "../message-queue.js";

describe("MemoryMessageQueue", () => {
  it("enqueue adds items and size reflects count", () => {
    const q = new MemoryMessageQueue();
    expect(q.size()).toBe(0);
    q.enqueue("msg1");
    expect(q.size()).toBe(1);
    q.enqueue("msg2");
    expect(q.size()).toBe(2);
  });

  it("drain returns all items in FIFO order", () => {
    const q = new MemoryMessageQueue();
    q.enqueue("first");
    q.enqueue("second");
    q.enqueue("third");
    const items = q.drain();
    expect(items).toEqual(["first", "second", "third"]);
  });

  it("drain empties the queue", () => {
    const q = new MemoryMessageQueue();
    q.enqueue("a");
    q.enqueue("b");
    q.drain();
    expect(q.size()).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it("clear empties the queue without returning items", () => {
    const q = new MemoryMessageQueue();
    q.enqueue("x");
    q.enqueue("y");
    q.clear();
    expect(q.size()).toBe(0);
    expect(q.drain()).toEqual([]);
  });

  it("works correctly after multiple drain cycles", () => {
    const q = new MemoryMessageQueue();
    q.enqueue("a");
    expect(q.drain()).toEqual(["a"]);
    q.enqueue("b");
    q.enqueue("c");
    expect(q.drain()).toEqual(["b", "c"]);
    expect(q.size()).toBe(0);
  });
});
