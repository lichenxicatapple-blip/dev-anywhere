import { describe, expect, it } from "vitest";
import { createPtyTouchScrollHandler } from "./pty-touch-scroll-handler";
import {
  createInitialPtyVerticalIntentState,
  reducePtyVerticalIntent,
  type PtyVerticalIntentEvent,
} from "./pty-vertical-intent-fsm";

function makeTouchEvent(touch: { clientX: number; clientY: number } | null): TouchEvent {
  return {
    touches: touch ? [touch] : [],
  } as unknown as TouchEvent;
}

function setReadonlyNumber(target: HTMLElement, key: string, value: number): void {
  Object.defineProperty(target, key, { configurable: true, value });
}

describe("pty touch scroll handler", () => {
  it("tracks a horizontal gesture outside the main scroll controller", () => {
    const container = document.createElement("div");
    container.scrollLeft = 0;
    container.scrollTop = 0;
    setReadonlyNumber(container, "scrollWidth", 800);
    setReadonlyNumber(container, "clientWidth", 200);
    setReadonlyNumber(container, "scrollHeight", 1200);
    setReadonlyNumber(container, "clientHeight", 400);

    let verticalIntent = createInitialPtyVerticalIntentState({ scrollTop: 0 });
    const dispatched: PtyVerticalIntentEvent[] = [];
    const horizontalInputs: string[] = [];
    const traces: string[] = [];

    const handler = createPtyTouchScrollHandler({
      container,
      atBottomThreshold: 8,
      trace: (event) => traces.push(event),
      getPageResumePending: () => false,
      getVerticalIntent: () => verticalIntent,
      dispatchVerticalIntent: (event) => {
        dispatched.push(event);
        const result = reducePtyVerticalIntent(verticalIntent, event, { atBottomThreshold: 8 });
        verticalIntent = result.state;
        return result;
      },
      getCurrentAnchor: () => ({ isAtBottom: true, bottomScrollTop: 0 }),
      getLastSeenScrollTop: () => 0,
      hasHorizontalOverflow: () => true,
      clearHorizontalIntentIfUnscrollable: () => false,
      markHorizontalUserInput: (details) => horizontalInputs.push(details),
      notifyAtBottom: () => {},
      flushPendingTouchScrollNotify: () => {},
    });

    handler.onTouchStart(makeTouchEvent({ clientX: 20, clientY: 100 }));
    handler.onTouchMove(makeTouchEvent({ clientX: 80, clientY: 102 }));

    expect(handler.getState().gestureMode).toBe("horizontal");
    expect(dispatched[0]?.type).toBe("touch-start");
    expect(horizontalInputs[0]).toContain("site=touchmove-horizontal");
    expect(traces).toContain("touchmove:horizontal-lock");
  });

  it("cleans transient touch state on touch end", () => {
    const container = document.createElement("div");
    container.scrollTop = 0;
    setReadonlyNumber(container, "scrollWidth", 200);
    setReadonlyNumber(container, "clientWidth", 200);
    setReadonlyNumber(container, "scrollHeight", 1200);
    setReadonlyNumber(container, "clientHeight", 400);

    let verticalIntent = createInitialPtyVerticalIntentState({ scrollTop: 0 });
    const dispatched: PtyVerticalIntentEvent[] = [];

    const handler = createPtyTouchScrollHandler({
      container,
      atBottomThreshold: 8,
      trace: () => {},
      getPageResumePending: () => false,
      getVerticalIntent: () => verticalIntent,
      dispatchVerticalIntent: (event) => {
        dispatched.push(event);
        const result = reducePtyVerticalIntent(verticalIntent, event, { atBottomThreshold: 8 });
        verticalIntent = result.state;
        return result;
      },
      getCurrentAnchor: () => ({ isAtBottom: true, bottomScrollTop: 0 }),
      getLastSeenScrollTop: () => 0,
      hasHorizontalOverflow: () => false,
      clearHorizontalIntentIfUnscrollable: () => true,
      markHorizontalUserInput: () => {},
      notifyAtBottom: () => {},
      flushPendingTouchScrollNotify: () => {},
    });

    handler.onTouchStart(makeTouchEvent({ clientX: 20, clientY: 100 }));
    handler.onTouchEnd();

    expect(handler.getState().gestureMode).toBeNull();
    expect(handler.getState().lastClientY).toBeNull();
    expect(dispatched.map((event) => event.type)).toEqual(["touch-start", "touch-end"]);
  });
});
