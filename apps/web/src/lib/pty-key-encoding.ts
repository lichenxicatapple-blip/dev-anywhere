const NORMAL_CURSOR_KEY_SEQUENCES = new Set(["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"]);

/**
 * Soft controls bypass xterm's native keydown encoder, so they must honor
 * DECCKM themselves. Full-screen programs such as Vim enable this mode and
 * expect SS3 cursor sequences instead of the normal CSI form.
 */
export function encodePtyInputForTerminalModes(
  data: string,
  modes: { applicationCursorKeysMode: boolean } | undefined,
): string {
  if (!modes?.applicationCursorKeysMode || !NORMAL_CURSOR_KEY_SEQUENCES.has(data)) return data;
  return `\x1bO${data.at(-1)}`;
}
