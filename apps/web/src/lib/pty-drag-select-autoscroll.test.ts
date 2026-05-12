import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attachPtyDragSelectAutoscroll,
  type DragSelectDebugSnapshot,
} from "./pty-drag-select-autoscroll";

interface Harness {
  container: HTMLDivElement;
  host: HTMLDivElement;
  scrollWidth: number;
  scrollHeight: number;
  clientWidth: number;
  clientHeight: number;
  rect: DOMRect;
  pendingFrame: (() => void) | null;
  flushFrame: () => void;
  getSnapshot: () => DragSelectDebugSnapshot;
  dispose: () => void;
}

function createHarness(opts: {
  scrollWidth?: number;
  scrollHeight?: number;
  clientWidth?: number;
  clientHeight?: number;
  rect?: { left: number; top: number; right: number; bottom: number };
}): Harness {
  const container = document.createElement("div");
  const host = document.createElement("div");
  container.appendChild(host);
  document.body.appendChild(container);

  const scrollWidth = opts.scrollWidth ?? 1600;
  const scrollHeight = opts.scrollHeight ?? 600;
  const clientWidth = opts.clientWidth ?? 800;
  const clientHeight = opts.clientHeight ?? 400;
  const rect = opts.rect ?? { left: 0, top: 0, right: clientWidth, bottom: clientHeight };
  Object.defineProperty(container, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(container, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(container, "clientWidth", { configurable: true, value: clientWidth });
  Object.defineProperty(container, "clientHeight", { configurable: true, value: clientHeight });
  container.getBoundingClientRect = () =>
    ({
      ...rect,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => null,
    }) as DOMRect;

  let pendingFrame: (() => void) | null = null;
  const requestFrame = (cb: () => void): number => {
    pendingFrame = cb;
    return 1;
  };
  const cancelFrame = (): void => {
    pendingFrame = null;
  };

  const handle = attachPtyDragSelectAutoscroll({
    container,
    host,
    requestFrame,
    cancelFrame,
  });

  return {
    container,
    host,
    scrollWidth,
    scrollHeight,
    clientWidth,
    clientHeight,
    rect: container.getBoundingClientRect(),
    get pendingFrame() {
      return pendingFrame;
    },
    flushFrame() {
      const fn = pendingFrame;
      pendingFrame = null;
      fn?.();
    },
    getSnapshot: handle.getDebugSnapshot,
    dispose() {
      handle.dispose();
      container.remove();
    },
  };
}

function pointerDown(
  target: Element,
  opts: { x: number; y: number; type?: string; button?: number },
): void {
  const event = new PointerEvent("pointerdown", {
    pointerType: opts.type ?? "mouse",
    button: opts.button ?? 0,
    clientX: opts.x,
    clientY: opts.y,
    bubbles: true,
  });
  target.dispatchEvent(event);
}
function pointerMove(opts: { x: number; y: number }): void {
  window.dispatchEvent(
    new PointerEvent("pointermove", { clientX: opts.x, clientY: opts.y, bubbles: true }),
  );
}
function pointerUp(): void {
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
}

describe("pty drag-select autoscroll", () => {
  let h: Harness;
  afterEach(() => h?.dispose());

  beforeEach(() => {
    // jsdom 不实现 PointerEvent 全部字段, 把 pointerType 当合法属性透传到 dispatch。
    if (typeof PointerEvent === "undefined") {
      // @ts-expect-error - jsdom polyfill
      globalThis.PointerEvent = class extends MouseEvent {
        pointerType: string;
        constructor(type: string, init: PointerEventInit & { pointerType?: string } = {}) {
          super(type, init);
          this.pointerType = init.pointerType ?? "";
        }
      };
    }
  });

  it("scrolls right when mouse drag enters the right edge zone", () => {
    h = createHarness({});
    pointerDown(h.container, { x: 100, y: 200 }); // anywhere inside
    pointerMove({ x: 790, y: 200 }); // 10px from right edge → inside 28px zone
    h.flushFrame();
    expect(h.container.scrollLeft).toBeGreaterThan(0);
  });

  it("scrolls left when mouse drag enters the left edge zone (cursor returned to col 0)", () => {
    h = createHarness({});
    h.container.scrollLeft = 600;
    pointerDown(h.container, { x: 400, y: 200 });
    pointerMove({ x: 5, y: 200 });
    h.flushFrame();
    expect(h.container.scrollLeft).toBeLessThan(600);
  });

  it("does not scroll when already at the rightmost position", () => {
    h = createHarness({});
    h.container.scrollLeft = h.scrollWidth - h.clientWidth; // 800
    pointerDown(h.container, { x: 100, y: 200 });
    pointerMove({ x: 795, y: 200 });
    h.flushFrame();
    expect(h.container.scrollLeft).toBe(800);
  });

  it("does not scroll without an active mouse drag", () => {
    h = createHarness({});
    pointerMove({ x: 795, y: 200 }); // 没 pointerdown
    h.flushFrame();
    expect(h.container.scrollLeft).toBe(0);
  });

  it("ignores touch pointer (mobile gesture path is separate)", () => {
    h = createHarness({});
    pointerDown(h.container, { x: 100, y: 200, type: "touch" });
    pointerMove({ x: 795, y: 200 });
    h.flushFrame();
    expect(h.container.scrollLeft).toBe(0);
  });

  it("ignores non-left mouse buttons", () => {
    h = createHarness({});
    pointerDown(h.container, { x: 100, y: 200, button: 2 });
    pointerMove({ x: 795, y: 200 });
    h.flushFrame();
    expect(h.container.scrollLeft).toBe(0);
  });

  it("stops scrolling on pointerup", () => {
    h = createHarness({});
    pointerDown(h.container, { x: 100, y: 200 });
    pointerMove({ x: 795, y: 200 });
    h.flushFrame();
    const after1 = h.container.scrollLeft;
    pointerUp();
    h.flushFrame();
    expect(h.container.scrollLeft).toBe(after1);
    expect(h.pendingFrame).toBeNull();
  });

  // host 派发会冒泡到父级, 但永远到不了子元素 .xterm-screen (xterm SelectionService
  // 真正的 listener 位置)。本测试钉死: 派发目标是 .xterm-screen 而不是 host。
  it("dispatches synthetic mousemove on .xterm-screen so xterm SelectionService receives it", () => {
    h = createHarness({});
    const xtermWrapper = document.createElement("div");
    xtermWrapper.className = "xterm";
    const xtermScreen = document.createElement("div");
    xtermScreen.className = "xterm-screen";
    xtermWrapper.appendChild(xtermScreen);
    h.host.appendChild(xtermWrapper);

    const screenEvents: MouseEvent[] = [];
    const hostEvents: MouseEvent[] = [];
    xtermScreen.addEventListener("mousemove", (e) => screenEvents.push(e as MouseEvent));
    h.host.addEventListener("mousemove", (e) => hostEvents.push(e as MouseEvent), {
      capture: false,
    });
    pointerDown(h.container, { x: 100, y: 200 });
    pointerMove({ x: 795, y: 200 });
    h.flushFrame();

    expect(screenEvents).toHaveLength(1);
    expect(screenEvents[0].clientX).toBe(795);
    expect(screenEvents[0].clientY).toBe(200);
    // 同时应该 bubble 到 host (因为 bubbles: true)。这条在事件不冒泡时也会失败,
    // 间接 lock dispatchEvent 用了 bubble=true 而不是 capture-only。
    expect(hostEvents).toHaveLength(1);
  });

  it("falls back to host dispatch when no .xterm-screen child exists yet", () => {
    h = createHarness({});
    const events: MouseEvent[] = [];
    h.host.addEventListener("mousemove", (e) => events.push(e as MouseEvent));
    pointerDown(h.container, { x: 100, y: 200 });
    pointerMove({ x: 795, y: 200 });
    h.flushFrame();
    expect(events).toHaveLength(1);
  });

  it("does not dispatch synthetic mousemove on idle frames (pointer not at edge)", () => {
    h = createHarness({});
    const events: MouseEvent[] = [];
    h.host.addEventListener("mousemove", (e) => events.push(e as MouseEvent));
    pointerDown(h.container, { x: 400, y: 200 }); // middle
    pointerMove({ x: 400, y: 200 });
    h.flushFrame();
    expect(events).toHaveLength(0);
  });

  it("debug snapshot reports xterm-screen target tag and dispatch count when scroll happens", () => {
    h = createHarness({});
    const xtermWrapper = document.createElement("div");
    xtermWrapper.className = "xterm";
    const xtermScreen = document.createElement("div");
    xtermScreen.className = "xterm-screen";
    xtermWrapper.appendChild(xtermScreen);
    h.host.appendChild(xtermWrapper);
    pointerDown(h.container, { x: 100, y: 200 });
    pointerMove({ x: 795, y: 200 });
    h.flushFrame();
    const snap = h.getSnapshot();
    expect(snap.dragging).toBe(true);
    expect(snap.dispatchCount).toBe(1);
    expect(snap.dispatchTargetTag).toBe("xterm-screen");
    expect(snap.lastScrollDelta).not.toBeNull();
    expect(snap.lastScrollDelta!.dx).toBeGreaterThan(0);
  });

  it("debug snapshot tags target as host when no .xterm-screen exists", () => {
    h = createHarness({});
    pointerDown(h.container, { x: 100, y: 200 });
    pointerMove({ x: 795, y: 200 });
    h.flushFrame();
    const snap = h.getSnapshot();
    expect(snap.dispatchTargetTag).toBe("host");
    expect(snap.dispatchCount).toBe(1);
  });

  it("debug snapshot dispatchCount stays 0 when pointer never enters edge zone", () => {
    h = createHarness({});
    pointerDown(h.container, { x: 400, y: 200 });
    pointerMove({ x: 400, y: 200 });
    h.flushFrame();
    const snap = h.getSnapshot();
    expect(snap.dragging).toBe(true);
    expect(snap.dispatchCount).toBe(0);
    expect(snap.dispatchTargetTag).toBe("unknown");
  });

  it("scrolls vertically when pointer hits top/bottom edge", () => {
    h = createHarness({ scrollHeight: 800, clientHeight: 400 });
    h.container.scrollTop = 200;
    pointerDown(h.container, { x: 400, y: 100 });
    pointerMove({ x: 400, y: 5 }); // top edge
    h.flushFrame();
    expect(h.container.scrollTop).toBeLessThan(200);

    pointerMove({ x: 400, y: 395 }); // bottom edge
    h.flushFrame();
    expect(h.container.scrollTop).toBeGreaterThan(0);
  });
});
