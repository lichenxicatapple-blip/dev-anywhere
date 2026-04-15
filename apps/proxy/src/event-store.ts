// CCAE 二进制事件持久化存储
// 格式定义：D-29 文件头，D-30 事件结构，D-31 事件类型
// 写入策略：D-02 每事件立即写盘，保持 fd 打开

import {
  openSync,
  closeSync,
  writeSync,
  readSync,
  readFileSync,
  statSync,
  existsSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

// 文件头常量
const CCAE_MAGIC = Buffer.from("CCAE", "ascii");
const CCAE_VERSION = 1;
export const HEADER_SIZE = 6; // 4B magic + 2B version
export const EVENT_OVERHEAD = 17; // 1B type + 8B timestamp + 4B payload_len + 4B total_len
const DEFAULT_ROTATION_THRESHOLD = 10 * 1024 * 1024; // 10MB
const SNAPSHOT_INTERVAL = 100; // 每 100 个事件触发一次快照

export const EventType = {
  PTY_DATA: 0x01,
  SNAPSHOT: 0x02,
  RESIZE: 0x03,
  METADATA: 0x04,
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

export interface DecodedEvent {
  type: EventTypeValue;
  timestamp: number;
  payload: Buffer;
  totalLen: number;
}

// 生成 6 字节文件头
export function writeFileHeader(): Buffer {
  const header = Buffer.alloc(HEADER_SIZE);
  CCAE_MAGIC.copy(header, 0);
  header.writeUInt16LE(CCAE_VERSION, 4);
  return header;
}

// 编码单个事件为二进制
// 结构：[1B type][8B timestamp float64LE][4B payload_len uint32LE][NB payload][4B total_len uint32LE]
export function encodeEvent(type: EventTypeValue, payload: Buffer, timestamp?: number): Buffer {
  const totalLen = EVENT_OVERHEAD + payload.length;
  const buf = Buffer.alloc(totalLen);
  let offset = 0;
  buf.writeUInt8(type, offset);
  offset += 1;
  buf.writeDoubleLE(timestamp ?? Date.now(), offset);
  offset += 8;
  buf.writeUInt32LE(payload.length, offset);
  offset += 4;
  payload.copy(buf, offset);
  offset += payload.length;
  buf.writeUInt32LE(totalLen, offset);
  return buf;
}

// 从 buffer 指定位置解码单个事件
export function decodeEvent(data: Buffer, offset: number): DecodedEvent {
  const type = data.readUInt8(offset) as EventTypeValue;
  const timestamp = data.readDoubleLE(offset + 1);
  const payloadLen = data.readUInt32LE(offset + 9);
  const payload = data.subarray(offset + 13, offset + 13 + payloadLen);
  const totalLen = data.readUInt32LE(offset + 13 + payloadLen);
  return { type, timestamp, payload, totalLen };
}

export class EventStore {
  private readonly eventsPath: string;
  private readonly rotationThreshold: number;
  private fd: number | null = null;
  private eventCount = 0;
  private metadata: { cols: number; rows: number; sessionId: string; createdAt: string } | null = null;

  constructor(eventsPath: string, rotationThreshold?: number) {
    this.eventsPath = eventsPath;
    this.rotationThreshold = rotationThreshold ?? DEFAULT_ROTATION_THRESHOLD;
  }

  // 初始化：创建文件写入 header + METADATA 事件
  open(metadata: { cols: number; rows: number; sessionId: string; createdAt: string }): void {
    this.metadata = metadata;
    this.fd = openSync(this.eventsPath, "a");

    // 写入文件头
    const header = writeFileHeader();
    writeSync(this.fd, header);

    // D-23: METADATA 作为文件第一个事件
    const metaPayload = Buffer.from(JSON.stringify(metadata), "utf-8");
    const metaEvent = encodeEvent(EventType.METADATA, metaPayload);
    writeSync(this.fd, metaEvent);
    this.eventCount = 1;
  }

  // D-02: 立即写盘，不做缓冲
  appendPtyData(data: Buffer): void {
    if (this.fd === null) throw new Error("EventStore not open");
    const event = encodeEvent(EventType.PTY_DATA, data);
    writeSync(this.fd, event);
    this.eventCount++;
  }

  // D-05: 快照作为 SNAPSHOT 事件写入
  appendSnapshot(serialized: string): void {
    if (this.fd === null) throw new Error("EventStore not open");
    const payload = Buffer.from(serialized, "utf-8");
    const event = encodeEvent(EventType.SNAPSHOT, payload);
    writeSync(this.fd, event);
    this.eventCount++;
  }

  // 写入终端尺寸变化事件
  appendResize(cols: number, rows: number): void {
    if (this.fd === null) throw new Error("EventStore not open");
    const payload = Buffer.alloc(4);
    payload.writeUInt16LE(cols, 0);
    payload.writeUInt16LE(rows, 2);
    const event = encodeEvent(EventType.RESIZE, payload);
    writeSync(this.fd, event);
    this.eventCount++;
  }

  // D-04: 每 SNAPSHOT_INTERVAL 个事件触发一次快照
  shouldSnapshot(): boolean {
    return this.eventCount > 0 && this.eventCount % SNAPSHOT_INTERVAL === 0;
  }

  // 检查活跃文件是否超过轮转阈值
  shouldRotate(): boolean {
    try {
      const size = statSync(this.eventsPath).size;
      return size >= this.rotationThreshold;
    } catch {
      return false;
    }
  }

  // D-15/D-49: 轮转活跃文件到 gzip 归档，新文件以 SNAPSHOT 开头确保自包含
  async rotate(currentSnapshot: string): Promise<void> {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }

    const dir = dirname(this.eventsPath);
    const seq = this.nextSequenceNumber(dir);
    const seqStr = String(seq).padStart(3, "0");
    const archivePath = `${dir}/events.${seqStr}.bin.gz`;

    // gzip 压缩旧文件
    await pipeline(
      createReadStream(this.eventsPath),
      createGzip(),
      createWriteStream(archivePath),
    );
    unlinkSync(this.eventsPath);

    // 创建新的 events.bin
    this.fd = openSync(this.eventsPath, "a");
    const header = writeFileHeader();
    writeSync(this.fd, header);

    // 写入 METADATA
    if (this.metadata) {
      const metaPayload = Buffer.from(JSON.stringify(this.metadata), "utf-8");
      const metaEvent = encodeEvent(EventType.METADATA, metaPayload);
      writeSync(this.fd, metaEvent);
    }

    // D-49: 新文件开头写入当前 SNAPSHOT
    const payload = Buffer.from(currentSnapshot, "utf-8");
    const snapshotEvent = encodeEvent(EventType.SNAPSHOT, payload);
    writeSync(this.fd, snapshotEvent);

    this.eventCount = 2; // METADATA + SNAPSHOT
  }

  // D-03: 会话结束时归档剩余文件
  async close(): Promise<void> {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }

    if (!existsSync(this.eventsPath)) return;

    const archivePath = `${this.eventsPath}.gz`;
    await pipeline(
      createReadStream(this.eventsPath),
      createGzip(),
      createWriteStream(archivePath),
    );
    unlinkSync(this.eventsPath);
  }

  // 同步关闭 fd，不做 gzip 归档（用于测试清理）
  closeSync(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  // D-48: 反向扫描找到最近的 SNAPSHOT 事件
  static findLatestSnapshot(eventsPath: string): Buffer | null {
    if (!existsSync(eventsPath)) return null;

    const fileSize = statSync(eventsPath).size;
    if (fileSize <= HEADER_SIZE) return null;

    const fd = openSync(eventsPath, "r");
    try {
      let pos = fileSize;

      while (pos > HEADER_SIZE) {
        // 读尾部 4 字节获取 total_len
        const trailerBuf = Buffer.alloc(4);
        readSync(fd, trailerBuf, 0, 4, pos - 4);
        const totalLen = trailerBuf.readUInt32LE(0);

        if (totalLen <= 0 || totalLen > pos - HEADER_SIZE) break;

        const eventStart = pos - totalLen;

        // 读事件类型
        const typeBuf = Buffer.alloc(1);
        readSync(fd, typeBuf, 0, 1, eventStart);
        const type = typeBuf.readUInt8(0);

        if (type === EventType.SNAPSHOT) {
          // 读完整事件
          const eventBuf = Buffer.alloc(totalLen);
          readSync(fd, eventBuf, 0, totalLen, eventStart);
          const decoded = decodeEvent(eventBuf, 0);
          return decoded.payload;
        }

        pos = eventStart;
      }

      return null;
    } finally {
      closeSync(fd);
    }
  }

  // 顺序读取文件中所有事件
  static readEventsFromFile(eventsPath: string): DecodedEvent[] {
    if (!existsSync(eventsPath)) return [];

    const data = readFileSync(eventsPath);
    if (data.length <= HEADER_SIZE) return [];

    // 验证 magic
    if (data.subarray(0, 4).toString("ascii") !== "CCAE") {
      throw new Error("Invalid CCAE file: bad magic header");
    }

    const events: DecodedEvent[] = [];
    let offset = HEADER_SIZE;

    while (offset + EVENT_OVERHEAD <= data.length) {
      const decoded = decodeEvent(data, offset);
      events.push(decoded);
      offset += decoded.totalLen;
    }

    return events;
  }

  // 从指定 snapshot offset 开始读取事件（含 snapshot 本身）
  static readEventsAfterSnapshot(eventsPath: string, snapshotOffset: number): DecodedEvent[] {
    if (!existsSync(eventsPath)) return [];

    const data = readFileSync(eventsPath);
    if (snapshotOffset >= data.length) return [];

    const events: DecodedEvent[] = [];
    let offset = snapshotOffset;

    while (offset + EVENT_OVERHEAD <= data.length) {
      const decoded = decodeEvent(data, offset);
      events.push(decoded);
      offset += decoded.totalLen;
    }

    return events;
  }

  // 扫描目录中已有的归档文件，确定下一个序号
  private nextSequenceNumber(dir: string): number {
    const files = readdirSync(dir);
    let max = 0;
    for (const f of files) {
      const match = f.match(/^events\.(\d{3})\.bin\.gz$/);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > max) max = n;
      }
    }
    return max + 1;
  }
}
