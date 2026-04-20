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
