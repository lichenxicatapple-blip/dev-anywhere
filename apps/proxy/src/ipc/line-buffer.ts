import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

// 将任意 data 事件分割为完整的 \n 分隔行
// Node.js data 事件不保证按行边界分割，此 Transform 保证每次 push 一个完整行
//
// 多字节 UTF-8 字符 (CJK 3 字节 / emoji 4 字节) 可能跨 chunk 边界。直接对单 chunk 调用
// Buffer.toString() 会把不完整字节序列解码成 U+FFFD 替换字符——claude / codex CLI 输出
// 中文 / emoji 时 stream-json 行变乱码, 解 JSON 失败被 schema 静默丢弃。StringDecoder
// 跨 chunk 维护内部状态, 不完整字节缓存到下一次 write 拼上再解。
export class LineBuffer extends Transform {
  private buffer = "";
  private decoder = new StringDecoder("utf8");

  _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
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
    // decoder.end() 把仍在缓存里的不完整字节序列以 U+FFFD 形式吐出, 避免静默丢字节
    const tail = this.decoder.end();
    if (tail.length > 0) this.buffer += tail;
    if (this.buffer.length > 0) {
      this.push(this.buffer);
      this.buffer = "";
    }
    callback();
  }
}
