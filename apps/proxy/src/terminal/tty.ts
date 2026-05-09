// 读 stdout cols/rows，非 TTY 抛错。
export function readTtySize(stream: NodeJS.WriteStream): { cols: number; rows: number } {
  const { columns, rows } = stream;
  if (columns === undefined || rows === undefined) {
    throw new Error(
      "stdout is not an interactive TTY (columns/rows undefined); dev-anywhere requires running in a real terminal",
    );
  }
  return { cols: columns, rows };
}

// 发一条 OSC 9 iTerm2-style 系统通知 + 响铃。iTerm2 / kitty / wezterm 等会弹出带 message
// 的系统通知；不认 OSC 9 的终端会忽略转义序列只剩下 BEL 响铃。
// 用此而非 stderr banner 的原因：dev-anywhere 对 Claude PTY 画面保持透明是硬约束，
// banner 会挤掉 Claude 的渲染行，OSC 9 不占画面，BEL 是纯听觉信号。
export function notifyUser(message: string): void {
  process.stderr.write(`\x1b]9;${message}\x07`);
}

// Provider TUI 可能开启 bracketed paste、application cursor/keypad、mouse tracking、
// xterm modifyOtherKeys 或 kitty keyboard protocol。若 provider 被远程终止或异常退出，
// 这些模式可能来不及自行恢复，外层 shell 会把 Ctrl-C 显示成 ";5;99~" 一类残留序列。
export function restoreHostTerminalModes(stream: NodeJS.WriteStream): void {
  if (!stream.isTTY) return;
  const restoreSequences = [
    "\x1b[?1l", // application cursor keys off
    "\x1b>", // application keypad off
    "\x1b[?1000l",
    "\x1b[?1002l",
    "\x1b[?1003l",
    "\x1b[?1004l",
    "\x1b[?1006l",
    "\x1b[?1015l",
    "\x1b[?2004l", // bracketed paste off
    "\x1b[>4;0m", // xterm modifyOtherKeys off
    "\x1b[<u", // kitty keyboard protocol off
  ].join("");
  stream.write(restoreSequences);
}
