// 发送队列只负责内存背压和有序 drain；持久化恢复由 relay/proxy 重拉协议承担。
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
