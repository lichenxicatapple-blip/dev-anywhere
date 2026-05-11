import type { Terminal } from "@xterm/xterm";

// 把 xterm active buffer 全部行抠成 \n 分隔的字符串。translateToString(true) 去尾空白，
// 用作 PTY 调试 dumpState / e2e 断言时取终端文本快照。空行（getLine 返 undefined）转空串保留。
export function serializeTerminalBuffer(term: Terminal): string {
  const activeBuffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < activeBuffer.length; i += 1) {
    lines.push(activeBuffer.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}
