import type { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { buildPtyScrollDebugSnapshot, type PtyScrollDebugProbe } from "./pty-scroll-debug-snapshot";

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
  rows?: number;
  scrollHeight?: number;
  scrollWidth?: number;
}) {
  const container = document.createElement("div") as HTMLDivElement;
  const spacer = document.createElement("div") as HTMLDivElement;
  const host = document.createElement("div") as HTMLDivElement;
  defineSize(container, { clientHeight: opts.clientHeight, clientWidth: 800 });
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    value: opts.scrollTop,
  });
  Object.defineProperty(container, "scrollHeight", {
    configurable: true,
    value: opts.scrollHeight ?? 2000,
  });
  Object.defineProperty(container, "scrollWidth", {
    configurable: true,
    value: opts.scrollWidth ?? 800,
  });
  spacer.style.height = "2000px";
  spacer.style.width = "800px";
  host.style.top = opts.hostTop;
  host.style.height = opts.hostHeight;
  host.style.width = "800px";
  host.style.paddingTop = "0px";

  const term = {
    rows: opts.rows ?? 20,
    cols: 80,
    buffer: {
      active: {
        length: opts.bufferLength,
        viewportY: opts.viewportY,
        baseY: Math.max(0, opts.bufferLength - (opts.rows ?? 20)),
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
  verticalIntentMode: "following",
  verticalIntentSource: "none",
  verticalIntentTransitionId: "attach.following",
  userHasHorizontalScrollIntent: false,
  pendingProgrammaticScrollTop: null,
  pendingFollowCursorScrollTop: null,
  pendingFollowCursorScrollLeft: null,
  prevCursorBufferRow: null,
  lastSeenScrollTop: 0,
  lastSeenScrollLeft: 0,
  touchScrollActive: false,
  touchScrollGestureMode: null,
  syncingInternal: false,
  syncingExternal: false,
  atBottomThreshold: 8,
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

  it("reports structured anchor, intent, and pending state", () => {
    const refs = makeRefs({
      scrollTop: 400,
      clientHeight: 400,
      hostTop: "400px",
      hostHeight: "400px",
      viewportY: 20,
      bufferLength: 100,
    });

    const snap = buildPtyScrollDebugSnapshot(
      () =>
        probe({
          userHasVerticalScrollIntent: true,
          verticalIntentMode: "reviewing",
          verticalIntentSource: "touch",
          verticalIntentTransitionId: "touch.start",
          userHasHorizontalScrollIntent: true,
          pendingFollowCursorScrollTop: 420,
          pendingFollowCursorScrollLeft: 64,
          pendingContainerSyncRetry: true,
          prevCursorBufferRow: 19,
          lastSeenScrollTop: 390,
          lastSeenScrollLeft: 12,
          touchScrollGestureMode: "vertical",
        }),
      refs,
    );

    expect(snap.intent).toEqual({ vertical: true, horizontal: true });
    expect(snap.verticalIntent).toEqual({
      mode: "reviewing",
      source: "touch",
      transitionId: "touch.start",
    });
    expect(snap.pending).toEqual({
      programmaticScrollTop: null,
      followCursorScrollTop: 420,
      followCursorScrollLeft: 64,
      containerSyncRetry: true,
    });
    expect(snap.anchor).toEqual(
      expect.objectContaining({
        atBottom: false,
        cursorBufferRow: 80,
      }),
    );
    expect(snap.prevCursorBufferRow).toBe(19);
    expect(snap.lastSeenScrollTop).toBe(390);
    expect(snap.lastSeenScrollLeft).toBe(12);
    expect(snap.touchScrollGestureMode).toBe("vertical");
  });

  it("matches positionHostAt's verticalOffset for small-buffer hosts", () => {
    // 构造小 buffer: rows=10, cellH=20 → hostHeight=200; visibleContentHeight=400 (clientHeight)。
    // positionHostAt 在这种情况下 verticalOffset = 400-200 = 200, 实际写: top = max(0, viewportY*20 + 200)。
    // viewportY=3 → expectedTop = 3*20 + 200 = 260, host 实际在 260, drift=0。
    // expectedHostHeight 必须用 term.rows*cellH (=10*20=200) 算, 不能读 host.style.height
    // ——init 早期 style 还没写时这俩会发散。
    const refs = makeRefs({
      scrollTop: 0,
      clientHeight: 400,
      hostTop: "260px",
      hostHeight: "200px",
      viewportY: 3,
      bufferLength: 10,
      rows: 10,
    });

    const snap = buildPtyScrollDebugSnapshot(() => probe(), refs);

    expect(snap.host.expectedTop).toBe(260);
    expect(snap.host.topDrift).toBe(0);
  });

  it("computes expectedTop from term.rows*cellH even when host.style.height is empty (init race)", () => {
    // 早期 init: updateSpacer 还没写 style.height → currentHostHeight=0。但 positionHostAt
    // 已经被 syncContainerScroll 调过, host.style.top 已经是 viewportY*cellH+offset。
    // expectedHostHeight 必须用 term.rows*cellH (=200) 而不是 currentHostHeight (=0),
    // 否则会把"还没写 height 的小 buffer host"误判成 hostHeight=0、offset=0、drift!=0 假阴性。
    const refs = makeRefs({
      scrollTop: 0,
      clientHeight: 400,
      hostTop: "260px",
      hostHeight: "", // style.height 还没写
      viewportY: 3,
      bufferLength: 10,
      rows: 10,
    });

    const snap = buildPtyScrollDebugSnapshot(() => probe(), refs);

    // 即便 host.style.height 是空的, expectedTop 仍然应当算出 260 (跟 positionHostAt 一致)
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
