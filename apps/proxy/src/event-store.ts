// CCAE 二进制事件持久化存储
// 文件格式：6 字节文件头 + 事件序列，每事件立即 writeSync 写盘

import {
  openSync,
  closeSync,
  writeSync,
  readSync,
  readFileSync,
  statSync,
  existsSync,
  unlinkSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

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
    mkdirSync(dirname(this.eventsPath), { recursive: true });
    this.fd = openSync(this.eventsPath, "a");

    // 写入文件头
    const header = writeFileHeader();
    writeSync(this.fd, header);

    // METADATA 作为文件第一个事件
    const metaPayload = Buffer.from(JSON.stringify(metadata), "utf-8");
    const metaEvent = encodeEvent(EventType.METADATA, metaPayload);
    writeSync(this.fd, metaEvent);
    this.eventCount = 1;
  }

  // 立即写盘，不做缓冲
  appendPtyData(data: Buffer): void {
    if (this.fd === null) throw new Error("EventStore not open");
    const event = encodeEvent(EventType.PTY_DATA, data);
    writeSync(this.fd, event);
    this.eventCount++;
  }

  // 快照作为 SNAPSHOT 事件写入
  // payload 格式: [2B cols LE][2B rows LE][serialize text bytes]
  appendSnapshot(serialized: string, cols: number, rows: number): void {
    if (this.fd === null) throw new Error("EventStore not open");
    const textBuf = Buffer.from(serialized, "utf-8");
    const payload = Buffer.alloc(4 + textBuf.length);
    payload.writeUInt16LE(cols, 0);
    payload.writeUInt16LE(rows, 2);
    textBuf.copy(payload, 4);
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

  // 每 SNAPSHOT_INTERVAL 个事件触发一次快照
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

  // 轮转：先写新文件（METADATA + 最新 SNAPSHOT），成功后替换旧文件，保证崩溃安全
  rotate(currentSnapshot: string, cols: number, rows: number): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }

    const tmpPath = this.eventsPath + ".tmp";
    const tmpFd = openSync(tmpPath, "w");

    const header = writeFileHeader();
    writeSync(tmpFd, header);

    if (this.metadata) {
      const metaPayload = Buffer.from(JSON.stringify(this.metadata), "utf-8");
      const metaEvent = encodeEvent(EventType.METADATA, metaPayload);
      writeSync(tmpFd, metaEvent);
    }

    const textBuf = Buffer.from(currentSnapshot, "utf-8");
    const snapshotPayload = Buffer.alloc(4 + textBuf.length);
    snapshotPayload.writeUInt16LE(cols, 0);
    snapshotPayload.writeUInt16LE(rows, 2);
    textBuf.copy(snapshotPayload, 4);
    const snapshotEvent = encodeEvent(EventType.SNAPSHOT, snapshotPayload);
    writeSync(tmpFd, snapshotEvent);

    closeSync(tmpFd);

    // 原子替换：新文件写入成功才覆盖旧文件
    renameSync(tmpPath, this.eventsPath);
    this.fd = openSync(this.eventsPath, "a");
    this.eventCount = 2; // METADATA + SNAPSHOT
  }

  // 关闭文件描述符，数据目录由 serve 的 onSessionRemoved 统一清理
  close(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  // 同步关闭 fd，不做 gzip 归档（用于测试清理）
  closeSync(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
  }

  // 反向扫描找到最近的 SNAPSHOT 事件
  // 返回 { cols, rows, data } 或 null，data 是 serialize 文本的 Buffer
  static findLatestSnapshot(eventsPath: string): { cols: number; rows: number; data: Buffer } | null {
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
          // payload 格式: [2B cols LE][2B rows LE][serialize text bytes]
          if (decoded.payload.length < 4) return null;
          const cols = decoded.payload.readUInt16LE(0);
          const rows = decoded.payload.readUInt16LE(2);
          const data = decoded.payload.subarray(4);
          return { cols, rows, data };
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

}
