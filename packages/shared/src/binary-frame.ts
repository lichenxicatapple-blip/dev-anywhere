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

export interface DecodedFileStreamFrame {
  streamId: string;
  chunkSeq: number;
  data: Uint8Array;
}

const SID_LEN_BYTES = 1;
const SEQ_BYTES = 4;
const HEADER_FIXED_BYTES = SID_LEN_BYTES + SEQ_BYTES;
const FILE_STREAM_MARKER = 0;
const FILE_STREAM_ID_LEN_BYTES = 1;
const FILE_STREAM_HEADER_FIXED_BYTES = 1 /* marker */ + FILE_STREAM_ID_LEN_BYTES + SEQ_BYTES;

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
  new DataView(frame.buffer, frame.byteOffset + seqOffset, SEQ_BYTES).setUint32(0, outputSeq, true);
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

export function encodeFileStreamFrame(
  streamId: string,
  chunkSeq: number,
  data: Uint8Array,
): Uint8Array {
  const streamIdBytes = new TextEncoder().encode(streamId);
  if (streamIdBytes.length === 0 || streamIdBytes.length > 255) {
    throw new RangeError(
      `streamId byte length must be 1-255, got ${streamIdBytes.length} (streamId=${streamId})`,
    );
  }
  if (!Number.isInteger(chunkSeq) || chunkSeq < 0 || chunkSeq > 0xffffffff) {
    throw new RangeError(`chunkSeq must be a uint32, got ${chunkSeq}`);
  }

  const frame = new Uint8Array(
    1 + FILE_STREAM_ID_LEN_BYTES + streamIdBytes.length + SEQ_BYTES + data.length,
  );
  frame[0] = FILE_STREAM_MARKER;
  frame[1] = streamIdBytes.length;
  frame.set(streamIdBytes, 1 + FILE_STREAM_ID_LEN_BYTES);
  const seqOffset = 1 + FILE_STREAM_ID_LEN_BYTES + streamIdBytes.length;
  new DataView(frame.buffer, frame.byteOffset + seqOffset, SEQ_BYTES).setUint32(0, chunkSeq, true);
  frame.set(data, seqOffset + SEQ_BYTES);
  return frame;
}

export function decodeFileStreamFrame(view: Uint8Array): DecodedFileStreamFrame | null {
  if (view.length < FILE_STREAM_HEADER_FIXED_BYTES) return null;
  if (view[0] !== FILE_STREAM_MARKER) return null;
  const streamIdLen = view[1];
  if (streamIdLen === 0) return null;
  if (view.length < 1 + FILE_STREAM_ID_LEN_BYTES + streamIdLen + SEQ_BYTES) return null;

  const streamId = new TextDecoder().decode(
    view.subarray(1 + FILE_STREAM_ID_LEN_BYTES, 1 + FILE_STREAM_ID_LEN_BYTES + streamIdLen),
  );
  const seqOffset = 1 + FILE_STREAM_ID_LEN_BYTES + streamIdLen;
  const chunkSeq = new DataView(view.buffer, view.byteOffset + seqOffset, SEQ_BYTES).getUint32(
    0,
    true,
  );
  const data = view.subarray(seqOffset + SEQ_BYTES);
  return { streamId, chunkSeq, data };
}

export function fileStreamFrameHeaderLength(streamId: string): number {
  const streamIdBytes = new TextEncoder().encode(streamId);
  return FILE_STREAM_HEADER_FIXED_BYTES + streamIdBytes.length;
}
