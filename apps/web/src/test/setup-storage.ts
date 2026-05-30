import "@testing-library/jest-dom/vitest";

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? (values.get(key) ?? null) : null;
    },
    key(index: number) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, String(value));
    },
  };
}

function hasUsableStorage(storage: unknown): storage is Storage {
  return (
    typeof storage === "object" &&
    storage !== null &&
    typeof (storage as Storage).getItem === "function" &&
    typeof (storage as Storage).setItem === "function" &&
    typeof (storage as Storage).removeItem === "function" &&
    typeof (storage as Storage).clear === "function"
  );
}

function ensureStorage(name: "localStorage" | "sessionStorage"): void {
  if (hasUsableStorage(globalThis[name])) return;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: createStorageMock(),
  });
}

ensureStorage("localStorage");
ensureStorage("sessionStorage");

if (typeof HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => null,
  });
}

if (
  typeof HTMLElement !== "undefined" &&
  typeof HTMLElement.prototype.scrollIntoView !== "function"
) {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
}

// jsdom 不实现 matchMedia, 给 window / globalThis 装一个最小 mock. 默认全部 query
// 不匹配 (等价桌面 + hover 设备); 需要测 touch surface 的用例自己 vi.spyOn 覆盖.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
