import { PTY_DEFAULT_BACKGROUND, PTY_DEFAULT_FOREGROUND } from "@dev-anywhere/shared";
import type { Terminal } from "@xterm/headless";

type Rgb = readonly [number, number, number];

// Match the color forms supported by xterm's OSC 10/11 handlers. In particular, #RGB uses
// significant high bits (XParseColor), while rgb:R/G/B scales each channel to the full range.
function parseColor(value: string): Rgb | null {
  const rgb = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/i.exec(value);
  if (rgb && rgb[1].length === rgb[2].length && rgb[1].length === rgb[3].length) {
    const maximum = 16 ** rgb[1].length - 1;
    const channel = (index: number): number =>
      Math.round((parseInt(rgb[index], 16) / maximum) * 255);
    return [channel(1), channel(2), channel(3)];
  }
  if (!/^#[\da-f]+$/i.test(value) || ![4, 7, 10, 13].includes(value.length)) return null;
  const width = (value.length - 1) / 3;
  const channel = (index: number): number => {
    const parsed = parseInt(value.slice(1 + index * width, 1 + (index + 1) * width), 16);
    return width === 1 ? parsed << 4 : parsed >> ((width - 2) * 4);
  };
  return [channel(0), channel(1), channel(2)];
}

/**
 * Hosted PTYs have no local terminal to answer their startup color probes. Reply from their
 * canonical parser, before any network round trip; Web viewers must not answer the same probes.
 * Registering with xterm keeps split chunks, BEL/ST endings and unrelated control strings intact.
 */
export function attachPtyDefaultColorResponder(
  terminal: Terminal,
  respond: (data: string) => void,
): void {
  const defaults = [parseColor(PTY_DEFAULT_FOREGROUND)!, parseColor(PTY_DEFAULT_BACKGROUND)!];
  const current = [...defaults];
  for (const code of [10, 11]) {
    terminal.parser.registerOscHandler(code, (data) => {
      if (data === "?") {
        const color = current[code - 10];
        const channels = color.map((channel) => channel.toString(16).padStart(2, "0").repeat(2));
        respond(`\x1b]${code};rgb:${channels.join("/")}\x1b\\`);
        return true;
      }
      // An OSC 10 setter may also set background via its second parameter. Queries with
      // multiple parameters keep their existing behavior; only standalone probes have one owner.
      for (const [offset, value] of data.split(";").entries()) {
        const index = code - 10 + offset;
        if (index >= current.length) break;
        const color = parseColor(value);
        if (color) current[index] = color;
      }
      return false;
    });
    terminal.parser.registerOscHandler(code + 100, () => {
      current[code - 10] = defaults[code - 10];
      return false;
    });
  }
}
