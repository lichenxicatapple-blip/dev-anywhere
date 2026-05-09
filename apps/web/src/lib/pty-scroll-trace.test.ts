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
  });

  it("can be enabled from a hash-routed chat URL", () => {
    window.history.replaceState(null, "", "/#/chat/session-1?mode=pty&ptyScrollTrace=1");

    expect(isPtyScrollTraceEnabled()).toBe(true);
  });

  it("can be enabled from localStorage", () => {
    installLocalStorageStub().setItem("dev_anywhere_pty_scroll_trace", "1");

    expect(isPtyScrollTraceEnabled()).toBe(true);
  });

  it("keeps only the most recent trace entries", () => {
    for (let i = 0; i < 505; i += 1) {
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

    expect(window.__devAnywherePtyScrollTrace).toHaveLength(500);
    expect(window.__devAnywherePtyScrollTrace?.[0]?.event).toBe("event-5");
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
    });

    const report = formatPtyScrollTraceReport();

    expect(report).toContain("DEV Anywhere PTY scroll trace");
    expect(report).toContain("container-scroll");
    expect(report).toContain("scrollMinusHost");
  });
});
