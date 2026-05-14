import { afterEach, describe, expect, it } from "vitest";
import {
  appendJsonScrollTrace,
  formatJsonScrollTraceReport,
  isJsonScrollTraceEnabled,
} from "./json-scroll-trace";

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

describe("json scroll trace", () => {
  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(window, "localStorage", originalLocalStorage);
    }
    window.history.replaceState(null, "", "/");
    window.__devAnywhereJsonScrollTrace = undefined;
  });

  it("can be enabled from a hash-routed chat URL", () => {
    window.history.replaceState(null, "", "/#/chat/session-1?mode=json&jsonScrollTrace=1");

    expect(isJsonScrollTraceEnabled()).toBe(true);
  });

  it("can be enabled from localStorage", () => {
    installLocalStorageStub().setItem("dev_anywhere_json_scroll_trace", "1");

    expect(isJsonScrollTraceEnabled()).toBe(true);
  });

  it("keeps only recent trace entries", () => {
    for (let i = 0; i < 5005; i += 1) {
      appendJsonScrollTrace({
        t: i,
        event: `event-${i}`,
        scrollTop: i,
        scrollHeight: 1000,
        clientHeight: 500,
        messageCount: 30,
        totalSize: 2400,
        firstIndex: 1,
        lastIndex: 8,
        focus: null,
      });
    }

    expect(window.__devAnywhereJsonScrollTrace).toHaveLength(5000);
    expect(window.__devAnywhereJsonScrollTrace?.[0]?.event).toBe("event-5");
  });

  it("formats a compact report for mobile copy/paste", () => {
    appendJsonScrollTrace({
      t: 100,
      event: "scroll",
      scrollTop: 42.4,
      scrollHeight: 1000,
      clientHeight: 500,
      visualViewportHeight: 450,
      visualViewportOffsetTop: 12,
      messageCount: 30,
      totalSize: 2400,
      firstIndex: 1,
      lastIndex: 8,
      focus: "BODY",
      historyLoading: true,
      historyHasMore: true,
      preservePrepend: true,
      scrollDelta: -14,
    });

    const report = formatJsonScrollTraceReport();

    expect(report).toContain("DEV Anywhere JSON scroll trace");
    expect(report).toContain("scroll");
    expect(report).toContain("directionFlips");
    expect(report).toContain("history");
  });
});
