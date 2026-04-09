import { createWriteStream, type WriteStream } from "node:fs";

// 数据旁路接口，Phase 2 为空操作，Phase 3-4 将注入 relay 转发逻辑
export type DataTap = (data: string) => void;

export function createNoopTap(): DataTap {
  return (_data: string) => {};
}

/**
 * 录制 tap：将每次 onData 回调的 chunk 记录为 NDJSON
 *
 * 每行格式：{"ts":<ms>,"data":"<escaped string>"}
 * 用于生成测试 fixture，精确还原真实的数据到达节奏和分片。
 */
export function createRecordingTap(outputPath: string): { tap: DataTap; stop: () => void } {
  const stream: WriteStream = createWriteStream(outputPath, { flags: "w" });
  const startTime = Date.now();

  const tap: DataTap = (data: string) => {
    const record = JSON.stringify({ ts: Date.now() - startTime, data });
    stream.write(record + "\n");
  };

  const stop = () => {
    stream.end();
  };

  return { tap, stop };
}
