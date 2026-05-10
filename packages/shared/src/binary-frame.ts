// PTY binary 帧 wire 格式（跨 proxy / relay / web 三方通用）：
//   [1B sessionId_len][sessionId UTF-8][4B outputSeq uint32LE][PTY data]
// 任一方手写偏移量都极易在协议演进时漂移，统一走这里编/解码避免分叉。
//
// 用 Uint8Array 而非 Buffer：shared 包必须可以在浏览器构建里跑，
// 不能依赖 Node-only 的 Buffer 全局。Node 调用方拿到的也是 Uint8Array
// （Buffer 是 Uint8Array 的子类，反向兼容），传给 ws.send 等 API 没问题。

export interface DecodedBinaryFrame {
  sessionId: string;
  outputSeq: number;
  data: Uint8Array;
}

const SID_LEN_BYTES = 1;
const SEQ_BYTES = 4;
const HEADER_FIXED_BYTES = SID_LEN_BYTES + SEQ_BYTES;

export function encodeBinaryFrame(
  sessionId: string,
  outputSeq: number,
  data: Uint8Array,
): Uint8Array {
  const sidBytes = new TextEncoder().encode(sessionId);
  if (sidBytes.length === 0 || sidBytes.length > 255) {
    throw new RangeError(
      `sessionId byte length must be 1-255, got ${sidBytes.length} (sessionId=${sessionId})`,
    );
  }
  if (!Number.isInteger(outputSeq) || outputSeq < 0 || outputSeq > 0xffffffff) {
    throw new RangeError(`outputSeq must be a uint32, got ${outputSeq}`);
  }

  const frame = new Uint8Array(SID_LEN_BYTES + sidBytes.length + SEQ_BYTES + data.length);
  frame[0] = sidBytes.length;
  frame.set(sidBytes, SID_LEN_BYTES);
  const seqOffset = SID_LEN_BYTES + sidBytes.length;
  // little-endian 与 Node 端 Buffer.writeUInt32LE / 浏览器 DataView setUint32(_, _, true) 保持一致
  new DataView(frame.buffer, frame.byteOffset + seqOffset, SEQ_BYTES).setUint32(
    0,
    outputSeq,
    true,
  );
  frame.set(data, seqOffset + SEQ_BYTES);
  return frame;
}

// 解码失败一律返回 null，调用方按业务诉求决定是丢帧还是关连接。
export function decodeBinaryFrame(view: Uint8Array): DecodedBinaryFrame | null {
  if (view.length < SID_LEN_BYTES + SEQ_BYTES) return null;
  const sidLen = view[0];
  if (sidLen === 0) return null;
  if (view.length < SID_LEN_BYTES + sidLen + SEQ_BYTES) return null;

  const sessionId = new TextDecoder().decode(view.subarray(SID_LEN_BYTES, SID_LEN_BYTES + sidLen));
  const seqOffset = SID_LEN_BYTES + sidLen;
  const outputSeq = new DataView(view.buffer, view.byteOffset + seqOffset, SEQ_BYTES).getUint32(
    0,
    true,
  );
  const data = view.subarray(seqOffset + SEQ_BYTES);
  return { sessionId, outputSeq, data };
}

// 帧头长度（不含 payload data）：调用方在做 chunk 拆分 / 估算缓冲时用得到。
export function binaryFrameHeaderLength(sessionId: string): number {
  const sidBytes = new TextEncoder().encode(sessionId);
  return HEADER_FIXED_BYTES + sidBytes.length;
}
