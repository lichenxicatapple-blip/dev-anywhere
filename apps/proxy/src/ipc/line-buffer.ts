import { Transform, type TransformCallback } from "node:stream";

// 将任意 data 事件分割为完整的 \n 分隔行
// Node.js data 事件不保证按行边界分割，此 Transform 保证每次 push 一个完整行
export class LineBuffer extends Transform {
  private buffer = "";

  _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString();
    const segments = this.buffer.split("\n");
    // 最后一段可能是不完整行，保留到 buffer
    this.buffer = segments.pop()!;

    for (const segment of segments) {
      if (segment.length > 0) {
        this.push(segment);
      }
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    if (this.buffer.length > 0) {
      this.push(this.buffer);
      this.buffer = "";
    }
    callback();
  }
}
