// 消息队列接口，Phase 5 用内存实现，接口预留持久化扩展
interface MessageQueue {
  enqueue(raw: string): void;
  drain(): string[];
  size(): number;
  clear(): void;
  dropOldest(): void;
}

export class MemoryMessageQueue implements MessageQueue {
  private items: string[] = [];

  enqueue(raw: string): void {
    this.items.push(raw);
  }

  drain(): string[] {
    const all = this.items;
    this.items = [];
    return all;
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  // 丢弃队列中最旧的一条消息
  dropOldest(): void {
    if (this.items.length > 0) {
      this.items.shift();
    }
  }
}
