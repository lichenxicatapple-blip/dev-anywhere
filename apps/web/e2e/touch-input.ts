import type { Page } from "@playwright/test";

export interface TouchPoint {
  x: number;
  y: number;
}

// CDP touch input goes through Chromium's hit testing and native pointer synthesis. It catches
// overlays that direct DOM dispatch would bypass, while working in both desktop touch emulation
// and the real Android Chrome test tier.
export async function dispatchTouchSwipe(
  page: Page,
  start: TouchPoint,
  end: TouchPoint,
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...start, id: 1, radiusX: 2, radiusY: 2, force: 1 }],
    });
    for (let step = 1; step <= 4; step += 1) {
      const progress = step / 4;
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          {
            x: start.x + (end.x - start.x) * progress,
            y: start.y + (end.y - start.y) * progress,
            id: 1,
            radiusX: 2,
            radiusY: 2,
            force: 1,
          },
        ],
      });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await session.detach();
  }
}
