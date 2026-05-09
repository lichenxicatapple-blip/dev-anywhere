const CSI = "\x1b[";

export function isOnlyPtyMouseInput(data: string): boolean {
  if (data === "") return false;
  let rest = data;
  while (rest.length > 0) {
    const consumed = mouseInputSequenceLength(rest);
    if (consumed === 0) return false;
    rest = rest.slice(consumed);
  }
  return true;
}

function mouseInputSequenceLength(data: string): number {
  if (data.startsWith(`${CSI}M`)) {
    return data.length >= 6 ? 6 : 0;
  }
  if (data.startsWith(`${CSI}<`)) {
    const match = data.slice(3).match(/^\d+;\d+;\d+[mM]/);
    return match?.[0] ? 3 + match[0].length : 0;
  }
  if (data.startsWith(CSI)) {
    const match = data.slice(2).match(/^\d+;\d+;\d+M/);
    return match?.[0] ? 2 + match[0].length : 0;
  }
  return 0;
}
