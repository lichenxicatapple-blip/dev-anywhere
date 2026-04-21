// 消息队列接口，接口预留持久化扩展
interface MessageQueue {
  enqueue(raw: string): void;
  drain(): string[];
  size(): number;
  clear(): void;
  dropOldest(): string | null;
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

  // 丢弃最旧消息，返回被丢弃的 raw 供 caller 做补偿（例如清理对应 pending 审批）
  dropOldest(): string | null {
    return this.items.shift() ?? null;
  }
}
