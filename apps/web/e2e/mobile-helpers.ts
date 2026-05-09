import { expect, type Locator, type Page } from "@playwright/test";

export const MOBILE_VIEWPORTS = {
  small: { width: 375, height: 667 },
  standard: { width: 390, height: 844 },
  landscape: { width: 844, height: 390 },
} as const;

export async function expectNoHorizontalDocumentOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    bodyScrollWidth: document.body.scrollWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(Math.max(metrics.bodyScrollWidth, metrics.docScrollWidth)).toBeLessThanOrEqual(
    metrics.innerWidth + 1,
  );
}

export async function expectTouchTarget(locator: Locator, min = 44): Promise<void> {
  await expect(locator).toBeVisible();
  await expect
    .poll(async () => {
      const box = await locator.boundingBox();
      return Math.min(box?.width ?? 0, box?.height ?? 0);
    })
    .toBeGreaterThanOrEqual(min);
}

export async function expectAllVisibleTouchTargets(page: Page, selector: string): Promise<void> {
  const locators = await page.locator(selector).all();
  for (const locator of locators) {
    if (!(await locator.isVisible())) continue;
    await expectTouchTarget(locator);
  }
}

export async function installVisualViewportMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    let height = window.innerHeight;
    let offsetTop = 0;

    const visualViewport = {
      get width() {
        return window.innerWidth;
      },
      get height() {
        return height;
      },
      get offsetTop() {
        return offsetTop;
      },
      get offsetLeft() {
        return 0;
      },
      get pageLeft() {
        return 0;
      },
      get pageTop() {
        return 0;
      },
      get scale() {
        return 1;
      },
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        const bucket = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
        bucket.add(listener);
        listeners.set(type, bucket);
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        listeners.get(type)?.delete(listener);
      },
      dispatchEvent(event: Event) {
        for (const listener of listeners.get(event.type) ?? []) {
          if (typeof listener === "function") listener.call(visualViewport, event);
          else listener.handleEvent(event);
        }
        return true;
      },
    };

    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: visualViewport,
    });

    Object.defineProperty(window, "__devAnywhereSetVisualViewport", {
      configurable: true,
      value(next: { height?: number; offsetTop?: number }) {
        height = next.height ?? height;
        offsetTop = next.offsetTop ?? offsetTop;
        visualViewport.dispatchEvent(new Event("resize"));
        visualViewport.dispatchEvent(new Event("scroll"));
      },
    });
  });
}

declare global {
  interface Window {
    __devAnywhereSetVisualViewport?: (next: { height?: number; offsetTop?: number }) => void;
  }
}
