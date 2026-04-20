// 读 stdout cols/rows，非 TTY 抛错。
export function readTtySize(stream: NodeJS.WriteStream): { cols: number; rows: number } {
  const { columns, rows } = stream;
  if (columns === undefined || rows === undefined) {
    throw new Error(
      "stdout is not an interactive TTY (columns/rows undefined); cc-anywhere requires running in a real terminal",
    );
  }
  return { cols: columns, rows };
}

// 发一条 OSC 9 iTerm2-style 系统通知 + 响铃。iTerm2 / kitty / wezterm 等会弹出带 message
// 的系统通知；不认 OSC 9 的终端会忽略转义序列只剩下 BEL 响铃。
// 用此而非 stderr banner 的原因：cc-anywhere 对 Claude PTY 画面保持透明是硬约束，
// banner 会挤掉 Claude 的渲染行，OSC 9 不占画面，BEL 是纯听觉信号。
export function notifyUser(message: string): void {
  process.stderr.write(`\x1b]9;${message}\x07`);
}
