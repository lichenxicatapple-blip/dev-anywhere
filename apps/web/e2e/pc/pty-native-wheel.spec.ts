import { expect, test, type Page } from "@playwright/test";
import { expectPtyTerminalMounted, setupPtyChat } from "../pty-fixture";
import {
  ptyTerminal,
  readPtyDebugSnapshot,
  readPtyScrollMetrics,
  readVisiblePtyRow,
  sendPtyOutput,
} from "../pty-scroll-helpers";

test.use({ viewport: { width: 1210, height: 702 }, hasTouch: true });

async function prepareTerminal(page: Page, sessionId: string): Promise<void> {
  await setupPtyChat(page, {
    sessionId,
    sessionKind: "agent",
    provider: "kimi",
    ptyOwner: "local-terminal",
    cols: 250,
    rows: 117,
    snapshotData:
      Array.from(
        { length: 600 },
        (_, index) => `wheel-row-${String(index).padStart(4, "0")} ${"x".repeat(220)}\r\n`,
      ).join("") + "\x1b[117;3H> ",
  });
  await expectPtyTerminalMounted(page);
  await expect
    .poll(async () => {
      const state = await readPtyDebugSnapshot(page);
      return (
        state?.term.cols === 250 &&
        state.term.rows === 117 &&
        state.host.height > state.visibleContentHeight &&
        state.container.scrollWidth > state.container.clientWidth &&
        state.verticalIntent.mode === "following" &&
        Math.abs(state.anchor.scrollTopDeltaToBottom) <= 2
      );
    })
    .toBe(true);
}

/**
 * Untrusted WheelEvents do not perform a browser default scroll. Explicitly simulate the
 * browser landing after a noncancelable event, including a render before its scroll notice.
 * This tests that ordering in real xterm/browser layout; it is not a physical iPad gesture.
 */
async function simulatedNativeWheel(
  page: Page,
  deltaX: number,
  deltaY: number,
  cancelable = false,
  landingDeltaYs = [deltaY],
) {
  return ptyTerminal(page).evaluate(
    async (element, delta) => {
      const container = element as HTMLElement;
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const read = () => ({
        top: container.scrollTop,
        left: container.scrollLeft,
        mode: window.__devAnywherePtyDebug?.()?.verticalIntent.mode,
        horizontalIntent: window.__devAnywherePtyDebug?.()?.intent.horizontal,
      });
      const before = read();
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: delta.cancelable,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaX: delta.x,
        deltaY: delta.y,
      });
      const term = window.__devAnywherePtyTerminal?.() as {
        rows: number;
        refresh(start: number, end: number): void;
      };
      // DOM assignments would each finish their own programmatic scroll. Suppress those
      // automatic ends so this fixture can model several landings from one native gesture.
      const holdScrollEnd = (scrollEvent: Event) => {
        if (scrollEvent.target === container) scrollEvent.stopImmediatePropagation();
      };
      window.addEventListener("scrollend", holdScrollEnd, true);
      const landings = [];
      try {
        container.dispatchEvent(event);
        const afterWheel = read();
        term.refresh(0, term.rows - 1);
        await frame();
        await frame();
        for (const [index, movement] of delta.landings.entries()) {
          const beforeLanding = read();
          const targetTop = Math.max(
            0,
            Math.min(container.scrollHeight - container.clientHeight, beforeLanding.top + movement),
          );
          const targetLeft = Math.max(
            0,
            Math.min(
              container.scrollWidth - container.clientWidth,
              beforeLanding.left + (index === 0 ? delta.x : 0),
            ),
          );
          // Delay only this fixture's scroll notification. The DOM coordinate lands first,
          // then xterm paints, then the controller receives the actual scroll position.
          const holdScrollNotice = (scrollEvent: Event) => {
            if (scrollEvent.target === container) scrollEvent.stopImmediatePropagation();
          };
          window.addEventListener("scroll", holdScrollNotice, true);
          let afterLanding;
          let beforeScrollNotice;
          try {
            container.scrollTop = targetTop;
            container.scrollLeft = targetLeft;
            afterLanding = read();
            term.refresh(0, term.rows - 1);
            await frame();
            await frame();
            beforeScrollNotice = read();
          } finally {
            window.removeEventListener("scroll", holdScrollNotice, true);
          }
          container.dispatchEvent(new Event("scroll"));
          await frame();
          await frame();
          landings.push({
            before: index === 0 ? before : beforeLanding,
            afterWheel: index === 0 ? afterWheel : beforeLanding,
            beforeLanding,
            afterLanding,
            beforeScrollNotice,
            afterScrollNotice: read(),
            targetTop,
            targetLeft,
            defaultPrevented: event.defaultPrevented,
          });
        }
      } finally {
        window.removeEventListener("scrollend", holdScrollEnd, true);
      }
      container.dispatchEvent(new Event("scrollend"));
      term.refresh(0, term.rows - 1);
      await frame();
      await frame();
      return { ...landings[0], landings, afterScrollEnd: read() };
    },
    { x: deltaX, y: deltaY, cancelable, landings: landingDeltaYs },
  );
}

function expectOneNativeMovement(
  step: Awaited<ReturnType<typeof simulatedNativeWheel>>["landings"][number],
): void {
  expect(step.defaultPrevented).toBe(false);
  expect(step.afterWheel.top, "wheel handler must not also move the native scroll").toBeCloseTo(
    step.before.top,
    0,
  );
  expect(
    step.beforeLanding.top,
    "a render before native landing must preserve position",
  ).toBeCloseTo(step.before.top, 0);
  for (const phase of ["afterLanding", "beforeScrollNotice", "afterScrollNotice"] as const) {
    expect(
      step[phase].top,
      `native landing must survive ${phase}: ${JSON.stringify(step)}`,
    ).toBeCloseTo(step.targetTop, 0);
  }
}

test("noncancelable wheel waits for native landing and never reverses an upward gesture", async ({
  page,
}, testInfo) => {
  await prepareTerminal(page, "pty-native-wheel-up");
  // Model a cancelable horizontal start, followed by noncancelable vertical events. This
  // injects the event flags explicitly; it does not assert WebKit's physical gesture policy.
  const start = await simulatedNativeWheel(page, 32, 0, true);
  expect(start.defaultPrevented).toBe(false);
  let previousTop = start.afterScrollNotice.top;
  const steps = [];
  for (const deltaY of [-96, -112, -80]) {
    const step = await simulatedNativeWheel(page, 0, deltaY);
    steps.push(step);
    expect(
      step.before.top,
      "the next event must not start after a reverse jump",
    ).toBeLessThanOrEqual(previousTop + 1);
    expectOneNativeMovement(step);
    const samples = [
      step.before,
      step.afterWheel,
      step.beforeLanding,
      step.afterLanding,
      step.beforeScrollNotice,
      step.afterScrollNotice,
    ];
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i].top, "upward wheel must not jump back down").toBeLessThanOrEqual(
        samples[i - 1].top + 1,
      );
    }
    expect(step.afterScrollNotice.mode).toBe("reviewing");
    previousTop = step.afterScrollNotice.top;
  }
  await testInfo.attach("simulated-native-wheel-order", {
    body: JSON.stringify(steps, null, 2),
    contentType: "application/json",
  });
});

test("one native wheel preserves multiple landings through scrollend and allows reverse movement", async ({
  page,
}, testInfo) => {
  await prepareTerminal(page, "pty-native-wheel-multiple-landings");
  // One injected wheel, three simulated native positions. No extra wheel grants ownership
  // between landings; every landing must survive a real xterm render before its scroll notice.
  const gesture = await simulatedNativeWheel(page, 0, -300, false, [-120, -100, -80]);
  await testInfo.attach("simulated-native-multiple-landings", {
    body: JSON.stringify(gesture, null, 2),
    contentType: "application/json",
  });
  expect(gesture.landings).toHaveLength(3);
  let previousTop = gesture.before.top;
  for (const landing of gesture.landings) {
    expectOneNativeMovement(landing);
    expect(landing.before.top).toBeCloseTo(previousTop, 0);
    expect(landing.afterScrollNotice.top).toBeLessThan(previousTop);
    expect(landing.afterScrollNotice.mode).toBe("reviewing");
    previousTop = landing.targetTop;
  }
  expect(gesture.afterScrollEnd.top).toBeCloseTo(gesture.before.top - 300, 0);
  expect(gesture.afterScrollEnd.mode).toBe("reviewing");

  // A new gesture really changes the DOM in the opposite direction. The controller must
  // consume those positions, rather than retaining the previous upward direction as a filter.
  const reverse = await simulatedNativeWheel(page, 0, 72, false, [24, 24, 24]);
  for (const landing of reverse.landings) {
    expectOneNativeMovement(landing);
    expect(landing.before.top).toBeCloseTo(previousTop, 0);
    expect(landing.afterScrollNotice.top).toBeGreaterThan(previousTop);
    previousTop = landing.targetTop;
  }
  expect(reverse.afterScrollEnd.top).toBeCloseTo(gesture.afterScrollEnd.top + 72, 0);
  expect(reverse.afterScrollEnd.mode).toBe("reviewing");
});

test("native downward wheel resumes following only after it actually lands at bottom", async ({
  page,
}) => {
  await prepareTerminal(page, "pty-native-wheel-bottom");
  const away = await simulatedNativeWheel(page, 0, -320);
  expectOneNativeMovement(away);
  const halfway = await simulatedNativeWheel(page, 0, 160);
  expectOneNativeMovement(halfway);
  expect(halfway.afterScrollNotice.mode).toBe("reviewing");

  const bottom = await simulatedNativeWheel(page, 0, 10_000);
  expectOneNativeMovement(bottom);
  expect(bottom.afterWheel.mode).toBe("reviewing");
  expect(bottom.beforeLanding.mode).toBe("reviewing");
  expect(bottom.afterScrollNotice.mode).toBe("following");
  await sendPtyOutput(page, "\r\nNATIVE-WHEEL-LIVE-PROBE\r\n");
  await expect.poll(() => readVisiblePtyRow(page, "NATIVE-WHEEL-LIVE-PROBE")).not.toBeNull();
  await expect
    .poll(async () => (await readPtyDebugSnapshot(page))?.verticalIntent.mode)
    .toBe("following");
});

test("mixed native wheel keeps horizontal review through later remote cursor movement", async ({
  page,
}) => {
  await prepareTerminal(page, "pty-native-wheel-mixed");
  const step = await simulatedNativeWheel(page, 64, -120);
  expectOneNativeMovement(step);
  expect(step.afterScrollNotice.left).toBeCloseTo(step.targetLeft, 0);
  expect(step.afterScrollNotice.horizontalIntent).toBe(true);
  expect(step.afterScrollNotice.mode).toBe("reviewing");

  await sendPtyOutput(page, "\x1b[116;1Hremote-status\x1b[117;230H");
  await expect.poll(async () => (await readPtyDebugSnapshot(page))?.term.cursorX).toBe(229);
  const afterOutput = await readPtyDebugSnapshot(page);
  expect(afterOutput?.container.scrollLeft).toBeCloseTo(step.targetLeft, 0);
  expect(afterOutput?.intent.horizontal).toBe(true);
});

test("ordinary browser wheel still scrolls once and returns to live following", async ({
  page,
}) => {
  await prepareTerminal(page, "pty-native-wheel-browser");
  const terminal = ptyTerminal(page);
  const box = await terminal.boundingBox();
  if (!box) throw new Error("terminal has no browser geometry");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 3; i++) {
    const before = await readPtyScrollMetrics(page);
    await page.mouse.wheel(0, -120);
    await expect
      .poll(async () => (await readPtyScrollMetrics(page)).scrollTop)
      .toBeLessThan(before.scrollTop - 1);
    const after = await readPtyScrollMetrics(page);
    expect(before.scrollTop - after.scrollTop).toBeLessThanOrEqual(122);
    expect((await readPtyDebugSnapshot(page))?.verticalIntent.mode).toBe("reviewing");
  }
  await page.mouse.wheel(0, 100_000);
  await expect
    .poll(async () => (await readPtyDebugSnapshot(page))?.verticalIntent.mode)
    .toBe("following");
  await expect
    .poll(async () => (await readPtyScrollMetrics(page)).bottomGap)
    .toBeLessThanOrEqual(2);
});
