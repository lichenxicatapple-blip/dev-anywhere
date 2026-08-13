const CSI = "\x1b[";

// Focus-aware terminal applications enable DECSET 1004. xterm then emits CSI I / CSI O through
// the same onData channel as keyboard input whenever its helper textarea gains or loses focus.
// Mouse reports use that channel as well. These reports must still reach the PTY, but they are
// protocol state rather than an instruction from the user to abandon history and follow the cursor.
export function isOnlyPtyNonTypingInput(data: string): boolean {
  if (data === "") return false;
  let rest = data;
  while (rest.length > 0) {
    const consumed = mouseInputSequenceLength(rest) || focusInputSequenceLength(rest);
    if (consumed === 0) return false;
    rest = rest.slice(consumed);
  }
  return true;
}

function focusInputSequenceLength(data: string): number {
  return data.startsWith(`${CSI}I`) || data.startsWith(`${CSI}O`) ? 3 : 0;
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
