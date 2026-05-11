import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import {
  buildPtyScrollDebugSnapshot,
  type PtyScrollDebugProbe,
} from "./pty-scroll-debug-snapshot";

function defineSize(el: HTMLElement, sizes: { clientHeight?: number; clientWidth?: number }): void {
  if (sizes.clientHeight !== undefined) {
    Object.defineProperty(el, "clientHeight", { configurable: true, value: sizes.clientHeight });
  }
  if (sizes.clientWidth !== undefined) {
    Object.defineProperty(el, "clientWidth", { configurable: true, value: sizes.clientWidth });
  }
}

function makeRefs(opts: {
  scrollTop: number;
  clientHeight: number;
  hostTop: string;
  hostHeight: string;
  viewportY: number;
  bufferLength: number;
}) {
  const container = document.createElement("div") as HTMLDivElement;
  const spacer = document.createElement("div") as HTMLDivElement;
  const host = document.createElement("div") as HTMLDivElement;
  defineSize(container, { clientHeight: opts.clientHeight, clientWidth: 800 });
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    value: opts.scrollTop,
  });
  spacer.style.height = "2000px";
  spacer.style.width = "800px";
  host.style.top = opts.hostTop;
  host.style.height = opts.hostHeight;
  host.style.width = "800px";
  host.style.paddingTop = "0px";

  const term = {
    rows: 20,
    cols: 80,
    buffer: {
      active: {
        length: opts.bufferLength,
        viewportY: opts.viewportY,
        baseY: 0,
        cursorX: 0,
        cursorY: 0,
      },
    },
  } as unknown as Terminal;

  return { container, spacer, host, term };
}

const probe = (overrides: Partial<PtyScrollDebugProbe> = {}): PtyScrollDebugProbe => ({
  cellH: 20,
  cellW: 10,
  paddingTop: 0,
  paddingBottom: 0,
  canvasLastY: -1,
  userHasVerticalScrollIntent: false,
  pendingProgrammaticScrollTop: null,
  touchScrollActive: false,
  lastSpacerUpdateAt: null,
  pendingContainerSyncRetry: false,
  ...overrides,
});

describe("buildPtyScrollDebugSnapshot", () => {
  it("reports full coverage when host fully spans the visible viewport", () => {
    // viewport [200, 600], host [200, 600]: 完全重合, coverage=1。
    const refs = makeRefs({
      scrollTop: 200,
      clientHeight: 400,
      hostTop: "200px",
      hostHeight: "400px",
      viewportY: 10,
      bufferLength: 100,
    });

    const snap = buildPtyScrollDebugSnapshot(() => probe(), refs);

    expect(snap.viewportHostCoverage).toBe(1);
    expect(snap.host.expectedTop).toBe(200);
    expect(snap.host.topDrift).toBe(0);
  });

  it("reports partial coverage and topDrift when host is below the viewport (blank-render case)", () => {
    // 模拟生产截图: viewport [400, 800] (clientHeight=400, scrollTop=400), host 卡在 stale
    // ydisp=10 → host.top=200, hostHeight=400 → host range [200, 600]。
    // 重叠 = [400, 600] = 200/400 = 0.5。expectedTop 应当跟着 viewportY=20 走 = 400, drift=-200。
    const refs = makeRefs({
      scrollTop: 400,
      clientHeight: 400,
      hostTop: "200px",
      hostHeight: "400px",
      viewportY: 20,
      bufferLength: 100,
    });

    const snap = buildPtyScrollDebugSnapshot(() => probe(), refs);

    expect(snap.viewportHostCoverage).toBe(0.5);
    expect(snap.host.expectedTop).toBe(400);
    expect(snap.host.topDrift).toBe(-200);
  });

  it("forwards pendingContainerSyncRetry from probe", () => {
    const refs = makeRefs({
      scrollTop: 0,
      clientHeight: 400,
      hostTop: "0px",
      hostHeight: "400px",
      viewportY: 0,
      bufferLength: 100,
    });

    const snap = buildPtyScrollDebugSnapshot(
      () => probe({ pendingContainerSyncRetry: true }),
      refs,
    );

    expect(snap.pendingContainerSyncRetry).toBe(true);
  });

  it("matches positionHostAt's verticalOffset for small-buffer hosts", () => {
    // hostHeight=200 < visibleContentHeight=400 → verticalOffset=200.
    // positionHostAt 实际写: top = max(0, viewportY*cellH + 200)。expectedTop 必须跟着。
    // viewportY=3, cellH=20 → 3*20+200=260, drift 应当为 0 (host 实际就在 260px)。
    const refs = makeRefs({
      scrollTop: 0,
      clientHeight: 400,
      hostTop: "260px",
      hostHeight: "200px",
      viewportY: 3,
      bufferLength: 10,
    });

    const snap = buildPtyScrollDebugSnapshot(() => probe(), refs);

    expect(snap.host.expectedTop).toBe(260);
    expect(snap.host.topDrift).toBe(0);
  });

  it("returns coverage=0 and expectedTop=0 when cellH=0 (probe pre-measurement)", () => {
    const refs = makeRefs({
      scrollTop: 100,
      clientHeight: 400,
      hostTop: "0px",
      hostHeight: "0px",
      viewportY: 5,
      bufferLength: 50,
    });

    const snap = buildPtyScrollDebugSnapshot(() => probe({ cellH: 0, cellW: 0 }), refs);

    // hostHeight=0 → 没有重叠
    expect(snap.viewportHostCoverage).toBe(0);
    // cellH=0 时 expectedTop 退回 0,而不是 NaN
    expect(snap.host.expectedTop).toBe(0);
  });
});
