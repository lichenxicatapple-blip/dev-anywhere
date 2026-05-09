interface PtyScrollTraceEntry {
  t: number;
  event: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  innerHeight?: number;
  visualViewportHeight?: number;
  visualViewportOffsetTop?: number;
  containerTop?: number;
  containerBottom?: number;
  hostRectTop?: number;
  hostRectBottom?: number;
  viewportY: number;
  bufferLength: number;
  hostTop: string;
  focus: string | null;
  atBottom?: boolean;
  touchActive?: boolean;
  userIntent?: boolean;
  ydisp?: number;
}

declare global {
  interface Window {
    __devAnywherePtyScrollTrace?: PtyScrollTraceEntry[];
  }
}

export function isPtyScrollTraceEnabled(): boolean {
  if (typeof window === "undefined") return false;
  const hashQueryStart = window.location.hash.indexOf("?");
  const routeParams =
    hashQueryStart >= 0
      ? new URLSearchParams(window.location.hash.slice(hashQueryStart + 1))
      : null;
  const pageParams = new URLSearchParams(window.location.search);
  return (
    pageParams.get("ptyScrollTrace") === "1" ||
    routeParams?.get("ptyScrollTrace") === "1" ||
    getLocalStorageFlag("dev_anywhere_pty_scroll_trace") === "1"
  );
}

function getLocalStorageFlag(key: string): string | null {
  try {
    const storage = window.localStorage;
    if (!storage || typeof storage.getItem !== "function") return null;
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function appendPtyScrollTrace(entry: PtyScrollTraceEntry): void {
  if (typeof window === "undefined") return;
  const trace = window.__devAnywherePtyScrollTrace ?? [];
  trace.push(entry);
  if (trace.length > 500) trace.splice(0, trace.length - 500);
  window.__devAnywherePtyScrollTrace = trace;
}

export function formatPtyScrollTraceReport(): string {
  const trace = window.__devAnywherePtyScrollTrace ?? [];
  const rows = trace.slice(-160);
  const scrollValues = rows.map((entry) => entry.scrollTop);
  const viewportValues = rows.map((entry) => entry.viewportY);
  const clientHeights = uniqueNumbers(rows.map((entry) => entry.clientHeight));
  const visualHeights = uniqueNumbers(rows.map((entry) => entry.visualViewportHeight));
  const focusValues = [...new Set(rows.map((entry) => entry.focus ?? "null"))].join(",");
  const flips = countDirectionFlips(scrollValues);
  const lines = rows.map((entry) =>
    [
      round(entry.t),
      entry.event,
      round(entry.scrollTop),
      entry.viewportY,
      entry.hostTop,
      round(entry.scrollTop - parsePx(entry.hostTop)),
      entry.clientHeight,
      entry.visualViewportHeight === undefined ? "" : round(entry.visualViewportHeight),
      entry.visualViewportOffsetTop === undefined ? "" : round(entry.visualViewportOffsetTop),
      entry.atBottom ? "bottom" : "",
      entry.touchActive ? "touch" : "",
      entry.userIntent ? "intent" : "",
      entry.focus ?? "",
    ].join("\t"),
  );

  return [
    "DEV Anywhere PTY scroll trace",
    `events=${trace.length}, included=${rows.length}`,
    `scrollTop=${range(scrollValues)}, viewportY=${range(viewportValues)}, directionFlips=${flips}`,
    `clientHeight=${clientHeights.join(",")}, visualViewportHeight=${visualHeights.join(",")}`,
    `focus=${focusValues}`,
    "t\tevent\tscrollTop\tviewportY\thostTop\tscrollMinusHost\tclientHeight\tvvHeight\tvvTop\tatBottom\ttouch\tintent\tfocus",
    ...lines,
  ].join("\n");
}

function parsePx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function range(values: number[]): string {
  if (values.length === 0) return "";
  return `${round(Math.min(...values))}..${round(Math.max(...values))}`;
}

function uniqueNumbers(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined).map(round))];
}

function countDirectionFlips(values: number[]): number {
  let previousDirection = 0;
  let flips = 0;
  for (let i = 1; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (Math.abs(delta) < 1) continue;
    const direction = Math.sign(delta);
    if (previousDirection !== 0 && direction !== previousDirection) flips += 1;
    previousDirection = direction;
  }
  return flips;
}
