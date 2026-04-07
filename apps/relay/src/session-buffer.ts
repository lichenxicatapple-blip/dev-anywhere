import type { MessageType, MessageSource } from "@cc-anywhere/shared";

// 缓冲消息元数据，原始 JSON 和解析后的关键字段用于压缩和查询
export interface BufferedMessage {
  raw: string;
  seq: number;
  type: MessageType;
  source: MessageSource;
}

// per-session 消息缓冲区，FIFO 淘汰，支持 seq 范围查询
export class SessionBuffer {
  private messages: BufferedMessage[] = [];
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  append(msg: BufferedMessage): void {
    this.messages.push(msg);
    if (this.messages.length > this.maxSize) {
      this.messages.shift();
    }
  }

  getAfterSeq(lastSeq: number): BufferedMessage[] {
    return this.messages.filter((m) => m.seq > lastSeq);
  }

  getRange(fromSeq: number, toSeq: number): BufferedMessage[] {
    return this.messages.filter((m) => m.seq >= fromSeq && m.seq <= toSeq);
  }

  getAll(): BufferedMessage[] {
    return [...this.messages];
  }

  // 直接替换内部消息数组，压缩器使用
  replaceMessages(msgs: BufferedMessage[]): void {
    this.messages = msgs;
  }

  size(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages = [];
  }
}
