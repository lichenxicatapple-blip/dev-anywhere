import { afterEach, describe, expect, it } from "vitest";
import {
  appendPtyScrollTrace,
  formatPtyScrollTraceReport,
  isPtyScrollTraceEnabled,
} from "./pty-scroll-trace";

const originalLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");

function installLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  } as Storage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: storage,
  });
  return storage;
}

describe("pty scroll trace", () => {
  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(window, "localStorage", originalLocalStorage);
    }
    window.history.replaceState(null, "", "/");
    window.__devAnywherePtyScrollTrace = undefined;
    delete (
      window as typeof window & {
        __devAnywherePtyDebug?: () => unknown;
      }
    ).__devAnywherePtyDebug;
  });

  it("does not enable from a hash-routed chat URL", () => {
    installLocalStorageStub();
    window.history.replaceState(null, "", "/#/chat/session-1?mode=pty&ptyScrollTrace=1");

    expect(isPtyScrollTraceEnabled()).toBe(false);
  });

  it("can be enabled from localStorage", () => {
    installLocalStorageStub().setItem("dev_anywhere_pty_scroll_trace", "1");

    expect(isPtyScrollTraceEnabled()).toBe(true);
  });

  it("keeps only the most recent trace entries", () => {
    for (let i = 0; i < 5005; i += 1) {
      appendPtyScrollTrace({
        t: i,
        event: `event-${i}`,
        scrollTop: i,
        scrollHeight: 1000,
        clientHeight: 500,
        viewportY: i,
        bufferLength: 100,
        hostTop: `${i}px`,
        focus: null,
      });
    }

    expect(window.__devAnywherePtyScrollTrace).toHaveLength(5000);
    expect(window.__devAnywherePtyScrollTrace?.[0]?.event).toBe("event-5");
  });

  it("keeps touch diagnostics in the copied report even when term-scroll floods the tail", () => {
    appendPtyScrollTrace({
      t: 1,
      event: "touchstart",
      scrollTop: 1600,
      scrollHeight: 2200,
      clientHeight: 600,
      viewportY: 80,
      bufferLength: 100,
      hostTop: "1600px",
      focus: "BODY",
      details: "startScroll=1600 bottom=1600",
    });
    for (let i = 0; i < 220; i += 1) {
      appendPtyScrollTrace({
        t: 2 + i,
        event: "term-scroll",
        scrollTop: 0,
        scrollHeight: 2200 + i,
        clientHeight: 600,
        viewportY: 0,
        bufferLength: 100 + i,
        hostTop: "0px",
        focus: "BODY",
      });
    }

    const report = formatPtyScrollTraceReport();

    expect(report).toContain("included=160");
    expect(report).toContain("touchstart");
    expect(report).toContain("startScroll=1600 bottom=1600");
  });

  it("folds steady-state cycles where unique events repeat in the same order", () => {
    // 真实稳态: 每帧 render → pending-frame:follow → scroll-to-bottom:start[pendingFrame] → end →
    // followCursor:skip → relayout:start → scroll-to-bottom:start[relayout] → end 8 条 unique events 轮流
    // fire, last-only dedup 失效 (相邻两条永远不同 event), entries 暴涨。
    // 期望: 同名事件折叠到该名字的最近 entry, cycle 内每个 event 各保留 1 条 + repeat 计数。
    const cycle = [
      "render",
      "pending-frame:follow",
      "scroll-to-bottom:start[pendingFrame]",
      "scroll-to-bottom:end",
      "followCursor:skip",
      "relayout:start",
      "scroll-to-bottom:start[relayout]",
      "scroll-to-bottom:end",
    ];
    const cycleCount = 100;
    for (let cycleIdx = 0; cycleIdx < cycleCount; cycleIdx += 1) {
      for (const event of cycle) {
        appendPtyScrollTrace({
          t: cycleIdx * 10 + cycle.indexOf(event),
          event,
          scrollTop: 90126,
          scrollHeight: 90976,
          clientHeight: 850,
          viewportY: 5000,
          bufferLength: 5052,
          hostTop: "90000px",
          focus: null,
        });
      }
    }
    const stored = window.__devAnywherePtyScrollTrace ?? [];
    expect(stored.length).toBeLessThanOrEqual(cycle.length * 2);
    // scroll-to-bottom:end 在 cycle 里出现两次 (pendingFrame 后 + relayout 后), 严格按 (event,
    // scrollTop, viewportY, hostTop) 折叠时这两次是同一 key, 总条数 cycle.length 或 -1。
    // 任何前一次 cycle 的 events 也不该残留, 按 dedup 设计每个 event 名应只剩最新 1 条。
    const eventNames = stored.map((entry) => entry.event);
    expect(new Set(eventNames).size).toBe(stored.length);
  });

  it("formats a compact report for mobile copy/paste", () => {
    appendPtyScrollTrace({
      t: 100,
      event: "container-scroll",
      scrollTop: 42.4,
      scrollHeight: 1000,
      clientHeight: 500,
      visualViewportHeight: 450,
      visualViewportOffsetTop: 12,
      viewportY: 2,
      bufferLength: 100,
      hostTop: "36px",
      focus: "BUTTON",
      atBottom: false,
      touchActive: true,
      userIntent: true,
      intentMode: "reviewing",
      intentSource: "touch",
      intentTransition: "touch.start",
    });

    const report = formatPtyScrollTraceReport();

    expect(report).toContain("DEV Anywhere PTY scroll trace");
    expect(report).toContain("container-scroll");
    expect(report).toContain("scope\taction\treason");
    expect(report).toContain("scrollMinusHost");
    expect(report).toContain("intentMode\tintentSource\tintentTransition");
    expect(report).toContain("reviewing\ttouch\ttouch.start");
    expect(report).toContain("debugSnapshot=");
  });

  it("includes the current debug snapshot in the copied report", () => {
    (window as unknown as Record<string, unknown>).__devAnywherePtyDebug = () => ({
      intent: { vertical: true, horizontal: false },
      anchor: { atBottom: false },
    });

    const report = formatPtyScrollTraceReport();

    expect(report).toContain('"intent"');
    expect(report).toContain('"vertical": true');
    expect(report).toContain('"atBottom": false');
  });

  it("normalizes dynamic event names into scope, action, and reason columns", () => {
    appendPtyScrollTrace({
      t: 100,
      event: "scroll-to-bottom:start[pendingFrame]",
      scrollTop: 42,
      scrollHeight: 1000,
      clientHeight: 500,
      viewportY: 2,
      bufferLength: 100,
      hostTop: "36px",
      focus: null,
    });

    const report = formatPtyScrollTraceReport();

    expect(report).toContain(
      "scroll-to-bottom:start[pendingFrame]\tscroll-to-bottom\tstart\tpendingFrame",
    );
  });

  it("summarizes follow-cursor deltas in the copied report", () => {
    appendPtyScrollTrace({
      t: 100,
      event: "followCursorY:hit",
      scrollTop: 17470,
      scrollHeight: 18100,
      clientHeight: 200,
      viewportY: 853,
      bufferLength: 905,
      hostTop: "17060px",
      focus: null,
      cursorY: 25,
      cursorBufferRow: 878,
      cursorDeltaRows: 25,
      scrollDeltaToAnchor: -410,
    } as Parameters<typeof appendPtyScrollTrace>[0]);

    const report = formatPtyScrollTraceReport();

    expect(report).toContain("cursorDeltaRows=25..25, scrollDeltaToAnchor=-410..-410");
    expect(report).toContain(
      "cursorBufferRow\tcursorDeltaRows\tcursorInViewport\tanchorBottomScrollTop\tscrollDeltaToAnchor",
    );
    expect(report).toContain("878\t25\t");
  });
});
