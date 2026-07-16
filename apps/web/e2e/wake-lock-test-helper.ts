import type { Page } from "@playwright/test";

export async function installWakeLockMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = {
      delayRequest: false,
      requests: 0,
      releases: 0,
      resolveRequest: null as (() => void) | null,
      sentinel: null as
        | (EventTarget & {
            released: boolean;
            release: () => Promise<void>;
          })
        | null,
    };
    Object.defineProperty(window, "__devAnywhereWakeLockTest", {
      configurable: true,
      value: state,
    });
    Object.defineProperty(navigator, "wakeLock", {
      configurable: true,
      value: {
        async request(type: "screen") {
          if (type !== "screen") throw new Error(`unexpected wake lock type: ${type}`);
          state.requests += 1;
          if (state.delayRequest) {
            await new Promise<void>((resolve) => {
              state.resolveRequest = resolve;
            });
          }
          const sentinel = new EventTarget() as EventTarget & {
            released: boolean;
            release: () => Promise<void>;
          };
          sentinel.released = false;
          sentinel.release = async () => {
            if (sentinel.released) return;
            sentinel.released = true;
            state.releases += 1;
            sentinel.dispatchEvent(new Event("release"));
          };
          state.sentinel = sentinel;
          return sentinel;
        },
      },
    });
  });
}

export async function wakeLockTestCount(
  page: Page,
  key: "requests" | "releases",
): Promise<number> {
  return page.evaluate(
    (stateKey) =>
      (
        window as Window & {
          __devAnywhereWakeLockTest?: Record<"requests" | "releases", number>;
        }
      ).__devAnywhereWakeLockTest?.[stateKey] ?? 0,
    key,
  );
}
