const CSI = "\x1b[";

// xterm exposes terminal mouse reports through the same onData channel as keyboard input.
// They must not be treated as an intent to return to the live prompt while the user is
// interacting with historical output (for example Cmd/Ctrl-clicking a file link).
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
  // Legacy X10/VT200 encoding: CSI M followed by three encoded bytes.
  if (data.startsWith(`${CSI}M`)) return data.length >= 6 ? 6 : 0;

  // SGR encoding: CSI < button ; x ; y M/m.
  if (data.startsWith(`${CSI}<`)) {
    const match = data.slice(3).match(/^\d+;\d+;\d+[mM]/);
    return match?.[0] ? 3 + match[0].length : 0;
  }

  // urxvt encoding: CSI button ; x ; y M.
  if (data.startsWith(CSI)) {
    const match = data.slice(2).match(/^\d+;\d+;\d+M/);
    return match?.[0] ? 2 + match[0].length : 0;
  }

  return 0;
}
