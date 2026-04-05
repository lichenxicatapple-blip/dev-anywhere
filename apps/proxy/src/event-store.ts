import {
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { sessionPaths } from "./paths.js";

// 二进制格式常量
const MAGIC = Buffer.from("CCAE", "ascii");
const VERSION = 1;
const HEADER_SIZE = 26; // 4(magic) + 1(version) + 21(sessionId)
const RECORD_HEADER_SIZE = 17; // 4(length) + 4(seq) + 8(ts) + 1(type)

export const EventType = {
  PTY_OUTPUT: 1,
  SNAPSHOT: 2,
  PTY_INPUT: 3,
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

export interface EventRecord {
  seq: number;
  ts: number;
  type: EventTypeValue;
  payload: Buffer;
}

function createFileHeader(sessionId: string): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  header.write(sessionId.slice(0, 21), 5, 21, "utf8");
  return header;
}

function encodeEvent(seq: number, ts: number, type: EventTypeValue, payload: Buffer): Buffer {
  const totalLen = RECORD_HEADER_SIZE + payload.length;
  const buf = Buffer.alloc(totalLen);
  buf.writeUInt32LE(totalLen, 0);
  buf.writeUInt32LE(seq, 4);
  buf.writeDoubleLE(ts, 8);
  buf.writeUInt8(type, 16);
  payload.copy(buf, RECORD_HEADER_SIZE);
  return buf;
}

function parseEvents(data: Buffer, afterSeq = 0): EventRecord[] {
  const events: EventRecord[] = [];
  if (data.length < HEADER_SIZE) return events;

  let offset = HEADER_SIZE;
  while (offset + RECORD_HEADER_SIZE <= data.length) {
    const totalLen = data.readUInt32LE(offset);
    if (offset + totalLen > data.length) break;

    const seq = data.readUInt32LE(offset + 4);
    const ts = data.readDoubleLE(offset + 8);
    const type = data.readUInt8(offset + 16) as EventTypeValue;
    const payload = data.subarray(offset + RECORD_HEADER_SIZE, offset + totalLen);

    if (seq > afterSeq) {
      events.push({ seq, ts, type, payload });
    }
    offset += totalLen;
  }
  return events;
}

export class EventStore {
  private readonly sessionId: string;
  private readonly eventsPath: string;
  private readonly archivePath: string;
  private readonly dir: string;
  private seq: number = 0;
  private buffer: Buffer[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly flushIntervalMs: number;

  constructor(sessionId: string, flushIntervalMs = 1000, baseDir?: string) {
    this.sessionId = sessionId;
    this.flushIntervalMs = flushIntervalMs;
    if (baseDir) {
      this.dir = `${baseDir}/${sessionId}`;
      this.eventsPath = `${this.dir}/events.bin`;
      this.archivePath = `${this.dir}/events.bin.gz`;
    } else {
      const paths = sessionPaths(sessionId);
      this.eventsPath = paths.events;
      this.archivePath = paths.archive;
      this.dir = paths.dir;
    }
    mkdirSync(this.dir, { recursive: true });
    this.initSeq();
  }

  // 追加事件到缓冲区，定时 flush 到磁盘
  append(type: EventTypeValue, payload: string | Buffer): void {
    const buf = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
    this.buffer.push(buf);

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush(type);
      }, this.flushIntervalMs);
    }
  }

  // 立即将缓冲区合并写入磁盘，返回分配的 seq
  flush(type: EventTypeValue = EventType.PTY_OUTPUT): number {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return this.seq;

    const merged = Buffer.concat(this.buffer);
    this.buffer = [];

    this.seq++;
    const ts = Date.now();

    // 文件不存在则先写 header
    if (!existsSync(this.eventsPath)) {
      writeFileSync(this.eventsPath, createFileHeader(this.sessionId));
    }

    const record = encodeEvent(this.seq, ts, type, merged);
    appendFileSync(this.eventsPath, record);
    return this.seq;
  }

  // 写入快照事件（不经过缓冲，直接写入）
  writeSnapshot(payload: Buffer): number {
    this.flush();
    this.seq++;
    const ts = Date.now();

    if (!existsSync(this.eventsPath)) {
      writeFileSync(this.eventsPath, createFileHeader(this.sessionId));
    }

    const record = encodeEvent(this.seq, ts, EventType.SNAPSHOT, payload);
    appendFileSync(this.eventsPath, record);
    return this.seq;
  }

  // 读取指定 seq 之后的事件
  readEvents(afterSeq = 0): EventRecord[] {
    const events: EventRecord[] = [];

    // 先读归档
    if (existsSync(this.archivePath)) {
      const compressed = readFileSync(this.archivePath);
      const decompressed = gunzipSync(compressed);
      events.push(...parseEvents(decompressed, afterSeq));
    }

    // 再读活跃文件
    if (existsSync(this.eventsPath)) {
      const data = readFileSync(this.eventsPath);
      events.push(...parseEvents(data, afterSeq));
    }

    return events;
  }

  // 获取最新的快照事件
  getLatestSnapshot(): EventRecord | null {
    const events = this.readEvents();
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === EventType.SNAPSHOT) {
        return events[i];
      }
    }
    return null;
  }

  getSeq(): number {
    return this.seq;
  }

  // gzip 归档活跃文件
  archive(): void {
    this.flush();
    if (!existsSync(this.eventsPath)) return;

    const data = readFileSync(this.eventsPath);
    if (data.length <= HEADER_SIZE) {
      unlinkSync(this.eventsPath);
      return;
    }

    const compressed = gzipSync(data);
    writeFileSync(this.archivePath, compressed);
    unlinkSync(this.eventsPath);
  }

  // 删除所有数据文件
  cleanup(): void {
    this.close();
    try { unlinkSync(this.eventsPath); } catch {}
    try { unlinkSync(this.archivePath); } catch {}
    try { unlinkSync(`${this.dir}/snapshot.bin`); } catch {}
  }

  close(): void {
    this.flush();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private initSeq(): void {
    // 从活跃文件读取最新 seq
    if (existsSync(this.eventsPath)) {
      const data = readFileSync(this.eventsPath);
      const events = parseEvents(data);
      if (events.length > 0) {
        this.seq = events[events.length - 1].seq;
        return;
      }
    }
    // 从归档读取
    if (existsSync(this.archivePath)) {
      const compressed = readFileSync(this.archivePath);
      const data = gunzipSync(compressed);
      const events = parseEvents(data);
      if (events.length > 0) {
        this.seq = events[events.length - 1].seq;
        return;
      }
    }
  }
}
