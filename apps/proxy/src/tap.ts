import { createWriteStream, type WriteStream } from "node:fs";

// 数据旁路接口，Phase 2 为空操作，Phase 3-4 将注入 relay 转发逻辑
export type DataTap = (data: string) => void;

export function createNoopTap(): DataTap {
  return (_data: string) => {};
}

/**
 * 录制 tap：将 PTY 数据和 resize 事件记录为 NDJSON
 *
 * 数据行格式：{"ts":<ms>,"data":"<escaped string>"}
 * resize 行格式：{"ts":<ms>,"resize":{"cols":<n>,"rows":<n>}}
 */
export function createRecordingTap(outputPath: string): {
  tap: DataTap;
  writeResize: (cols: number, rows: number) => void;
  stop: () => void;
} {
  const stream: WriteStream = createWriteStream(outputPath, { flags: "w" });
  const startTime = Date.now();

  const tap: DataTap = (data: string) => {
    const record = JSON.stringify({ ts: Date.now() - startTime, data });
    stream.write(record + "\n");
  };

  const writeResize = (cols: number, rows: number) => {
    const record = JSON.stringify({ ts: Date.now() - startTime, resize: { cols, rows } });
    stream.write(record + "\n");
  };

  const stop = () => {
    stream.end();
  };

  return { tap, writeResize, stop };
}
