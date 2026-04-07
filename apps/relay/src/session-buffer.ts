import type { MessageType, MessageSource } from "@cc-anywhere/shared";
import type { BufferStore } from "./buffer-store.js";

// 缓冲消息元数据，原始 JSON 和解析后的关键字段用于压缩和查询
export interface BufferedMessage {
  raw: string;
  seq: number;
  type: MessageType;
  source: MessageSource;
}

// per-session 消息缓冲区，支持 seq 范围查询，大小由压缩策略控制
// 可选绑定 BufferStore 实现磁盘持久化
export class SessionBuffer {
  private messages: BufferedMessage[] = [];
  private store: BufferStore | null;
  private sessionId: string | null;

  constructor(store: BufferStore | null = null, sessionId: string | null = null) {
    this.store = store;
    this.sessionId = sessionId;
  }

  // 从磁盘加载已有消息，不触发写入
  loadMessages(msgs: BufferedMessage[]): void {
    this.messages = msgs;
  }

  append(msg: BufferedMessage): void {
    // seq 去重：EventStore 回放时可能重发 relay 已有的消息
    if (this.messages.length > 0 && msg.seq <= this.messages[this.messages.length - 1].seq) {
      return;
    }
    this.messages.push(msg);
    if (this.store && this.sessionId) {
      this.store.append(this.sessionId, msg);
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
    if (this.store && this.sessionId) {
      this.store.rewrite(this.sessionId, msgs);
    }
  }

  // 缓冲区中最大的 seq，用于重连对账
  getLastSeq(): number {
    if (this.messages.length === 0) return -1;
    return this.messages[this.messages.length - 1].seq;
  }

  size(): number {
    return this.messages.length;
  }

  clear(): void {
    this.messages = [];
    if (this.store && this.sessionId) {
      this.store.delete(this.sessionId);
    }
  }
}
