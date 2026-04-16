// events.bin 校验器：读取 CCAE 二进制文件，输出事件摘要
// 用法: tsx apps/proxy/src/tools/inspect-events.ts <events.bin path>

import { openSync, closeSync, readSync, statSync } from "node:fs";

const EVENT_TYPES: Record<number, string> = {
  0x01: "PTY_DATA",
  0x02: "SNAPSHOT",
  0x03: "RESIZE",
  0x04: "METADATA",
};

const HEADER_SIZE = 6; // 4B magic + 2B version
const EVENT_OVERHEAD = 17; // 1B type + 8B timestamp + 4B payload_len + 4B total_len

function inspectEvents(filePath: string): void {
  const stat = statSync(filePath);
  console.log(`File: ${filePath}`);
  console.log(`Size: ${stat.size} bytes`);
  console.log("---");

  const fd = openSync(filePath, "r");

  // 读取文件头
  const headerBuf = Buffer.alloc(HEADER_SIZE);
  readSync(fd, headerBuf, 0, HEADER_SIZE, 0);

  const magic = headerBuf.subarray(0, 4).toString("ascii");
  const version = headerBuf.readUInt16LE(4);
  console.log(`Header: magic=${magic}, version=${version}`);

  if (magic !== "CCAE") {
    console.error("ERROR: Invalid magic bytes, expected 'CCAE'");
    closeSync(fd);
    process.exit(1);
  }

  // 顺序读取事件
  let offset = HEADER_SIZE;
  let eventIndex = 0;
  let ptyDataBytes = 0;
  let ptyDataCount = 0;

  while (offset < stat.size) {
    // 至少需要 EVENT_OVERHEAD 字节
    if (offset + EVENT_OVERHEAD > stat.size) {
      console.error(`WARN: Truncated event at offset ${offset}, remaining ${stat.size - offset} bytes`);
      break;
    }

    // 读取事件头: 1B type + 8B timestamp + 4B payload_len
    const headerLen = 1 + 8 + 4;
    const evHeader = Buffer.alloc(headerLen);
    readSync(fd, evHeader, 0, headerLen, offset);

    const type = evHeader[0];
    const timestamp = evHeader.readDoubleLE(1);
    const payloadLen = evHeader.readUInt32LE(9);

    // 计算 total_len 并读取尾部 trailer 验证
    const expectedTotalLen = EVENT_OVERHEAD + payloadLen;
    const trailerOffset = offset + headerLen + payloadLen;

    if (trailerOffset + 4 > stat.size) {
      console.error(`WARN: Truncated trailer at event ${eventIndex}, offset ${offset}`);
      break;
    }

    const trailerBuf = Buffer.alloc(4);
    readSync(fd, trailerBuf, 0, 4, trailerOffset);
    const actualTotalLen = trailerBuf.readUInt32LE(0);

    const typeName = EVENT_TYPES[type] ?? `UNKNOWN(0x${type.toString(16)})`;
    const date = new Date(timestamp);
    const trailerOk = actualTotalLen === expectedTotalLen;

    if (type === 0x01) {
      // PTY_DATA: 只计数，不逐条打印
      ptyDataCount++;
      ptyDataBytes += payloadLen;
    } else {
      // 非 PTY_DATA 事件详细打印
      let payloadPreview = "";
      if (type === 0x04) {
        // METADATA: 读取 JSON
        const payloadBuf = Buffer.alloc(Math.min(payloadLen, 500));
        readSync(fd, payloadBuf, 0, payloadBuf.length, offset + headerLen);
        payloadPreview = ` | ${payloadBuf.toString("utf-8").slice(0, 200)}`;
      } else if (type === 0x03) {
        // RESIZE: 读取 cols/rows
        const resizeBuf = Buffer.alloc(4);
        readSync(fd, resizeBuf, 0, 4, offset + headerLen);
        payloadPreview = ` | cols=${resizeBuf.readUInt16LE(0)}, rows=${resizeBuf.readUInt16LE(2)}`;
      } else if (type === 0x02) {
        // SNAPSHOT: 显示大小
        payloadPreview = ` | serialized ${payloadLen} bytes`;
      }

      console.log(
        `[${eventIndex}] ${typeName} @ ${date.toISOString()} | payload=${payloadLen}B | trailer=${trailerOk ? "OK" : "MISMATCH"}${payloadPreview}`
      );
    }

    // 如果到了非 PTY_DATA 事件前有累积的 PTY_DATA，先输出汇总
    if (type !== 0x01 && ptyDataCount > 0) {
      // 在前一个位置已经输出过了
    }

    eventIndex++;
    offset += expectedTotalLen;
  }

  // 输出 PTY_DATA 汇总
  if (ptyDataCount > 0) {
    console.log(`\n--- PTY_DATA summary: ${ptyDataCount} events, ${ptyDataBytes} bytes total ---`);
  }

  console.log(`\nTotal events: ${eventIndex}`);
  console.log(`File integrity: ${offset === stat.size ? "OK" : `MISMATCH (parsed ${offset}, file ${stat.size})`}`);

  closeSync(fd);
}

const filePath = process.argv[2];
if (!filePath) {
  console.error("Usage: tsx apps/proxy/src/tools/inspect-events.ts <events.bin path>");
  process.exit(1);
}

inspectEvents(filePath);
