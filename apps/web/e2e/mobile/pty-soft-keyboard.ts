import { expect, type Locator, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CHROME_NOTIFICATIONS_PROMPT = "Chrome notifications make things easier";
const CHROME_SEARCH_PROMPT = "Search with Sogou";

async function adbArgs(): Promise<string[]> {
  if (process.env.ANDROID_SERIAL) return ["-s", process.env.ANDROID_SERIAL];

  const { stdout } = await execFileAsync("adb", ["devices"]);
  const devices = stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial?.startsWith("emulator-") && state === "device")
    .map(([serial]) => serial);
  if (devices.length !== 1) {
    throw new Error(
      `Expected exactly one Android emulator or ANDROID_SERIAL, found: ${devices.join(", ") || "none"}`,
    );
  }
  return ["-s", devices[0]];
}

async function isNativeSoftKeyboardVisible(serialArgs: string[]): Promise<boolean> {
  const { stdout } = await execFileAsync("adb", [...serialArgs, "shell", "dumpsys", "window"]);
  return /mImeShowing=true/.test(stdout) || /type=ime[^\n]*visible=true/.test(stdout);
}

type AndroidPtyDismissGesture = {
  css: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  };
  native: {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
  };
};

function parseAndroidBounds(node: string | undefined): [number, number, number, number] | null {
  const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!bounds) return null;
  return [Number(bounds[1]), Number(bounds[2]), Number(bounds[3]), Number(bounds[4])];
}

async function readAndroidWindowHierarchy(serialArgs: string[]): Promise<string> {
  const dumpPath = "/sdcard/dev-anywhere-window.xml";
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await execFileAsync("adb", [...serialArgs, "shell", "uiautomator", "dump", dumpPath]);
      const { stdout } = await execFileAsync("adb", [...serialArgs, "shell", "cat", dumpPath]);
      return stdout;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `Could not read Android window hierarchy: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function waitForViewportFramesToSettle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let previous = "";
        let stableFrames = 0;
        const sample = () => {
          const viewport = window.visualViewport;
          const current = JSON.stringify({
            innerHeight: window.innerHeight,
            innerWidth: window.innerWidth,
            viewportHeight: viewport?.height ?? window.innerHeight,
            viewportWidth: viewport?.width ?? window.innerWidth,
            viewportTop: viewport?.offsetTop ?? 0,
          });
          stableFrames = current === previous ? stableFrames + 1 : 0;
          previous = current;
          if (stableFrames >= 3) {
            resolve();
            return;
          }
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }),
  );
}

export async function tapWithAdb(locator: Locator): Promise<void> {
  const label = await locator.getAttribute("aria-label");
  if (!label) throw new Error("Android tap target needs an aria-label");
  const serialArgs = await adbArgs();
  const dumpPath = "/sdcard/dev-anywhere-window.xml";
  let node: string | undefined;
  let lastHierarchy = "";
  let lastDumpError = "";
  for (let attempt = 0; attempt < 10 && !node; attempt += 1) {
    let hierarchy: string;
    try {
      await execFileAsync("adb", [...serialArgs, "shell", "uiautomator", "dump", dumpPath]);
      ({ stdout: hierarchy } = await execFileAsync("adb", [
        ...serialArgs,
        "shell",
        "cat",
        dumpPath,
      ]));
      lastDumpError = "";
    } catch (error) {
      lastDumpError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    lastHierarchy = hierarchy;
    node = [...hierarchy.matchAll(/<node\b[^>]*>/g)]
      .map(([value]) => value)
      .find(
        (value) =>
          value.includes(`text="${label}"`) ||
          value.includes(`content-desc="${label}"`) ||
          value.includes(`hint="${label}"`),
      );
    if (
      !node &&
      (hierarchy.includes(CHROME_NOTIFICATIONS_PROMPT) || hierarchy.includes(CHROME_SEARCH_PROMPT))
    ) {
      const dismissButton = [...hierarchy.matchAll(/<node\b[^>]*>/g)]
        .map(([value]) => value)
        .find((value) => {
          if (hierarchy.includes(CHROME_NOTIFICATIONS_PROMPT)) {
            return (
              value.includes('resource-id="com.android.chrome:id/negative_button"') &&
              value.includes('text="No thanks"')
            );
          }
          return (
            value.includes('resource-id="com.android.chrome:id/button_secondary"') &&
            value.includes('text="Keep Google"')
          );
        });
      const dismissBounds = dismissButton?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (dismissBounds) {
        const [, left, top, right, bottom] = dismissBounds.map(Number);
        await execFileAsync("adb", [
          ...serialArgs,
          "shell",
          "input",
          "tap",
          `${Math.round((left + right) / 2)}`,
          `${Math.round((top + bottom) / 2)}`,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
    }
    if (
      !node &&
      hierarchy.includes('content-desc="Web View"') &&
      hierarchy.includes('text="No internet connection"')
    ) {
      break;
    }
    if (!node) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const chromeWebTreeIsStale =
    lastHierarchy.includes('content-desc="Web View"') &&
    lastHierarchy.includes('text="No internet connection"');
  let bounds = chromeWebTreeIsStale
    ? undefined
    : node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!bounds) {
    // Chrome can keep the document fully rendered while Android marks the
    // emulator network PARTIAL_CONNECTIVITY and shows its native "No internet
    // connection" chip. In that state UIAutomator intermittently omits all web
    // descendants and exposes only the WebView frame. Preserve a real ADB touch
    // by projecting Playwright's CSS rect into that native frame.
    const webViewNode = [...lastHierarchy.matchAll(/<node\b[^>]*>/g)]
      .map(([value]) => value)
      .find(
        (value) =>
          value.includes('package="com.android.chrome"') &&
          value.includes('content-desc="Web View"'),
      );
    const webViewBounds = webViewNode?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    const chromeToolbarNode = [...lastHierarchy.matchAll(/<node\b[^>]*>/g)]
      .map(([value]) => value)
      .find((value) => value.includes('resource-id="com.android.chrome:id/control_container"'));
    const chromeToolbarBounds = chromeToolbarNode?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    const visibleTapTarget =
      label === "Terminal input" ? locator.page().locator('[data-slot="pty-terminal"]') : locator;
    const [rect, viewport] = await Promise.all([
      visibleTapTarget.boundingBox(),
      locator.page().evaluate(() => ({
        width: window.visualViewport?.width ?? window.innerWidth,
        height: window.visualViewport?.height ?? window.innerHeight,
        offsetLeft: window.visualViewport?.offsetLeft ?? 0,
        offsetTop: window.visualViewport?.offsetTop ?? 0,
      })),
    ]);
    if (webViewBounds && rect && viewport.width > 0 && viewport.height > 0) {
      const [, webLeft, webTop, webRight, webBottom] = webViewBounds.map(Number);
      const scale = (webRight - webLeft) / viewport.width;
      const contentTop = chromeToolbarBounds
        ? Number(chromeToolbarBounds[4])
        : Math.max(webTop, webBottom - viewport.height * scale);
      const projectedCenterX = Math.round(webLeft + (rect.x + rect.width / 2) * scale);
      const projectedCenterY = Math.round(contentTop + (rect.y + rect.height / 2) * scale);
      if (
        projectedCenterX >= webLeft &&
        projectedCenterX <= webRight &&
        projectedCenterY >= Math.max(0, contentTop) &&
        projectedCenterY <= webBottom
      ) {
        bounds = [
          "",
          String(projectedCenterX),
          String(projectedCenterY),
          String(projectedCenterX),
          String(projectedCenterY),
        ];
      }
    }
  }
  if (!bounds) {
    const visibleNodes = [...lastHierarchy.matchAll(/<node\b[^>]*>/g)]
      .map(([value]) => value)
      .filter((value) => /(?:text|content-desc|hint)="[^"]+"/.test(value))
      .slice(0, 8)
      .join("\n");
    throw new Error(
      `Android accessibility target missing: ${label}${lastDumpError ? `\nLast hierarchy error: ${lastDumpError}` : ""}${visibleNodes ? `\nVisible nodes:\n${visibleNodes}` : ""}`,
    );
  }
  const [, left, top, right, bottom] = bounds.map(Number);
  const x = Math.round((left + right) / 2);
  const y = Math.round((top + bottom) / 2);

  if (label !== "Terminal input") {
    await locator.evaluate((element) => {
      const target = element as HTMLElement & { __devAnywhereAdbEvents?: string[] };
      target.__devAnywhereAdbEvents = [];
      target.addEventListener(
        "pointerdown",
        () => target.__devAnywhereAdbEvents?.push("pointerdown"),
        { once: true },
      );
      target.addEventListener("click", () => target.__devAnywhereAdbEvents?.push("click"), {
        once: true,
      });
    });
  }

  // `uiautomator dump` and `input tap` share Android's accessibility/input
  // pipeline. Issuing the tap in the same instant can be acknowledged by adb
  // before Chrome receives it. One rendered frame releases the dump without
  // turning a missed product interaction into a retry.
  await locator
    .page()
    .evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  if (label === "Terminal input") {
    // The keyboard changes layout immediately after this DOWN event. Keep the
    // activation gesture instantaneous so its UP cannot land on newly mounted
    // PTY controls.
    await execFileAsync("adb", [...serialArgs, "shell", "input", "tap", `${x}`, `${y}`]);
  } else {
    await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "input",
      "touchscreen",
      "swipe",
      `${x}`,
      `${y}`,
      `${x}`,
      `${y}`,
      "80",
    ]);
  }
  if (label !== "Terminal input") {
    const deliveredEvents = await locator.evaluate(
      (element) =>
        (element as HTMLElement & { __devAnywhereAdbEvents?: string[] }).__devAnywhereAdbEvents ??
        [],
    );
    if (!deliveredEvents.includes("click")) {
      throw new Error(
        `Android touch did not click ${label} at (${x},${y}); events=${deliveredEvents.join(",") || "none"}`,
      );
    }
  }
}

export async function touchPtyTerminal(page: Page): Promise<void> {
  const input = page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // UIAutomator bounds can become stale between dump and input tap while xterm
    // is continuously painting. Re-resolve the native bounds only when the tap
    // demonstrably did not reach the textarea.
    await tapWithAdb(input);
    try {
      await expect(input).toBeFocused({ timeout: 1_000 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

export async function waitForSoftKeyboard(page: Page): Promise<void> {
  const serialArgs = await adbArgs();
  await expect
    .poll(() => isNativeSoftKeyboardVisible(serialArgs), {
      timeout: 10_000,
      message: "Android soft keyboard did not become visible",
    })
    .toBe(true);

  try {
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Number(
              document
                .querySelector("[data-keyboard-offset]")
                ?.getAttribute("data-keyboard-offset") ?? "0",
            ),
          ),
        { timeout: 10_000, message: "Android soft keyboard did not produce a keyboard offset" },
      )
      .toBeGreaterThan(0);
  } catch (error) {
    const [web, nativeWindow] = await Promise.all([
      page.evaluate(() => ({
        activeTag: document.activeElement?.tagName ?? null,
        activeLabel: document.activeElement?.getAttribute("aria-label") ?? null,
        innerHeight: window.innerHeight,
        innerWidth: window.innerWidth,
        visualViewport: window.visualViewport
          ? {
              height: window.visualViewport.height,
              width: window.visualViewport.width,
              offsetTop: window.visualViewport.offsetTop,
              pageTop: window.visualViewport.pageTop,
              scale: window.visualViewport.scale,
            }
          : null,
        keyboardOffset: document
          .querySelector("[data-keyboard-offset]")
          ?.getAttribute("data-keyboard-offset"),
        keyboardLayoutInset: document
          .querySelector("[data-keyboard-layout-inset]")
          ?.getAttribute("data-keyboard-layout-inset"),
      })),
      execFileAsync("adb", [...serialArgs, "shell", "dumpsys", "window"]).then(({ stdout }) =>
        stdout
          .split("\n")
          .filter((line) => /mImeShowing|type=ime|InsetsSource.*ime|imeControlTarget/.test(line))
          .slice(0, 20),
      ),
    ]);
    throw new Error(
      `Android IME is native-visible but Web viewport did not open:\n${JSON.stringify(
        { web, nativeWindow },
        null,
        2,
      )}\n${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function waitForPtyControlsToSettleAboveKeyboard(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const timeoutAt = performance.now() + 20_000;
        let alignedSince: number | null = null;

        const sample = () => {
          const controls = document.querySelector('[data-slot="pty-mobile-controls"]');
          const controlsRect = controls?.getBoundingClientRect();
          const viewportTop = window.visualViewport?.offsetTop ?? 0;
          const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
          const viewportBottom = viewportTop + viewportHeight;
          const gap = controlsRect ? viewportBottom - controlsRect.bottom : Number.NaN;
          const aligned = controlsRect != null && gap >= -2 && gap <= 24;
          const now = performance.now();

          if (aligned) {
            alignedSince ??= now;
            if (now - alignedSince >= 500) {
              resolve();
              return;
            }
          } else {
            alignedSince = null;
          }

          if (now >= timeoutAt && aligned) {
            resolve();
            return;
          }

          if (now >= timeoutAt) {
            reject(
              new Error(
                `PTY controls did not settle above Android keyboard: gap=${String(gap)}, viewportTop=${viewportTop}, viewportHeight=${viewportHeight}`,
              ),
            );
            return;
          }
          requestAnimationFrame(sample);
        };

        requestAnimationFrame(sample);
      }),
  );
}

export async function dismissSoftKeyboard(page: Page): Promise<void> {
  const serialArgs = await adbArgs();
  if (await isNativeSoftKeyboardVisible(serialArgs)) {
    await execFileAsync("adb", [...serialArgs, "shell", "input", "keyevent", "4"]);
  }
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  await expect
    .poll(async () => !(await isNativeSoftKeyboardVisible(serialArgs)), {
      timeout: 10_000,
      message: "Android soft keyboard did not close between tests",
    })
    .toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Number(
            document
              .querySelector("[data-keyboard-offset]")
              ?.getAttribute("data-keyboard-offset") ?? "0",
          ),
        ),
      {
        timeout: 10_000,
        message: "Web viewport did not return to the keyboard-closed baseline",
      },
    )
    .toBe(0);
}

export async function swipeDownPtyToDismissSoftKeyboard(
  page: Page,
): Promise<AndroidPtyDismissGesture> {
  const serialArgs = await adbArgs();
  if (!(await isNativeSoftKeyboardVisible(serialArgs))) {
    throw new Error("Android soft keyboard must be visible before the PTY dismiss gesture");
  }

  const geometry = await page.evaluate(() => {
    const terminal = document.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    const screen = terminal?.querySelector<HTMLElement>(".xterm-screen");
    if (!terminal || !screen) return null;

    const terminalRect = terminal.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const viewport = {
      width: window.visualViewport?.width ?? window.innerWidth,
      height: window.visualViewport?.height ?? window.innerHeight,
      offsetLeft: window.visualViewport?.offsetLeft ?? 0,
      offsetTop: window.visualViewport?.offsetTop ?? 0,
    };
    const visibleLeft = Math.max(terminalRect.left, screenRect.left, viewport.offsetLeft);
    const visibleRight = Math.min(
      terminalRect.right,
      screenRect.right,
      viewport.offsetLeft + viewport.width,
    );
    const visibleTop = Math.max(terminalRect.top, screenRect.top, viewport.offsetTop);
    const visibleBottom = Math.min(
      terminalRect.bottom,
      screenRect.bottom,
      viewport.offsetTop + viewport.height,
    );
    const visibleHeight = visibleBottom - visibleTop;
    if (visibleRight - visibleLeft < 80 || visibleHeight < 160) return null;

    const startX = (visibleLeft + visibleRight) / 2;
    const startY = visibleTop + visibleHeight * 0.28;
    const endY = Math.min(visibleBottom - 24, startY + Math.min(140, visibleHeight * 0.42));
    const startTarget = document.elementFromPoint(startX, startY);
    const endTarget = document.elementFromPoint(startX, endY);
    return {
      terminalRect: {
        left: terminalRect.left,
        top: terminalRect.top,
        right: terminalRect.right,
        bottom: terminalRect.bottom,
      },
      screenRect: {
        left: screenRect.left,
        top: screenRect.top,
        right: screenRect.right,
        bottom: screenRect.bottom,
      },
      viewport,
      startX,
      startY,
      endX: startX,
      endY,
      startHitsXterm: startTarget instanceof Element && Boolean(startTarget.closest(".xterm")),
      endHitsXterm: endTarget instanceof Element && Boolean(endTarget.closest(".xterm")),
    };
  });
  if (!geometry) {
    throw new Error("Android PTY does not expose a large enough visible xterm area for swipe");
  }
  if (!geometry.startHitsXterm || !geometry.endHitsXterm) {
    throw new Error(
      `PTY dismiss gesture does not stay on xterm: ${JSON.stringify({
        startHitsXterm: geometry.startHitsXterm,
        endHitsXterm: geometry.endHitsXterm,
        terminalRect: geometry.terminalRect,
        screenRect: geometry.screenRect,
        viewport: geometry.viewport,
      })}`,
    );
  }

  const hierarchy = await readAndroidWindowHierarchy(serialArgs);
  const nodes = [...hierarchy.matchAll(/<node\b[^>]*>/g)].map(([node]) => node);
  const webViewBounds = parseAndroidBounds(
    nodes.find(
      (node) =>
        node.includes('package="com.android.chrome"') &&
        (node.includes('class="android.webkit.WebView"') ||
          node.includes('content-desc="Web View"')),
    ),
  );
  const toolbarBounds = parseAndroidBounds(
    nodes.find((node) => node.includes('resource-id="com.android.chrome:id/control_container"')),
  );
  if (!webViewBounds) {
    throw new Error("Android Chrome WebView bounds are missing from the window hierarchy");
  }

  const [webLeft, webTop, webRight, webBottom] = webViewBounds;
  const contentTop = toolbarBounds ? Math.max(webTop, toolbarBounds[3]) : webTop;
  const scale = (webRight - webLeft) / geometry.viewport.width;
  const toNativeX = (clientX: number) =>
    Math.round(webLeft + (clientX - geometry.viewport.offsetLeft) * scale);
  const toNativeY = (clientY: number) =>
    Math.round(contentTop + (clientY - geometry.viewport.offsetTop) * scale);
  const native = {
    startX: toNativeX(geometry.startX),
    startY: toNativeY(geometry.startY),
    endX: toNativeX(geometry.endX),
    endY: toNativeY(geometry.endY),
  };
  if (
    native.startX < webLeft ||
    native.startX > webRight ||
    native.endX < webLeft ||
    native.endX > webRight ||
    native.startY < contentTop ||
    native.startY > webBottom ||
    native.endY < contentTop ||
    native.endY > webBottom
  ) {
    throw new Error(
      `Projected PTY swipe leaves Android Chrome WebView: ${JSON.stringify({ native, webViewBounds, contentTop, geometry })}`,
    );
  }

  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await execFileAsync("adb", [
    ...serialArgs,
    "shell",
    "input",
    "touchscreen",
    "swipe",
    `${native.startX}`,
    `${native.startY}`,
    `${native.endX}`,
    `${native.endY}`,
    "400",
  ]);
  await expect
    .poll(async () => !(await isNativeSoftKeyboardVisible(serialArgs)), {
      timeout: 10_000,
      message: "The real downward PTY gesture did not close Android's soft keyboard",
    })
    .toBe(true);
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          Number(
            document
              .querySelector("[data-keyboard-offset]")
              ?.getAttribute("data-keyboard-offset") ?? "0",
          ),
        ),
      { timeout: 10_000, message: "Web viewport did not settle after the PTY dismiss gesture" },
    )
    .toBe(0);
  await waitForViewportFramesToSettle(page);

  return {
    css: {
      startX: geometry.startX,
      startY: geometry.startY,
      endX: geometry.endX,
      endY: geometry.endY,
    },
    native,
  };
}

export async function setAndroidEmulatorDisplaySize(
  page: Page,
  size: { width: number; height: number } | "baseline",
): Promise<void> {
  const serialArgs = await adbArgs();
  const serial = serialArgs.at(-1) ?? "";
  if (!serial.startsWith("emulator-")) {
    throw new Error(
      `Refusing to change display size on non-emulator device: ${serial || "unknown"}`,
    );
  }

  if (size === "baseline") {
    await execFileAsync("adb", [...serialArgs, "shell", "wm", "size", "reset"]);
    await execFileAsync("adb", [...serialArgs, "shell", "wm", "density", "reset"]);
    await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "settings",
      "put",
      "system",
      "user_rotation",
      "0",
    ]);
    await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "settings",
      "put",
      "system",
      "accelerometer_rotation",
      "1",
    ]);
  } else {
    if (
      !Number.isInteger(size.width) ||
      !Number.isInteger(size.height) ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      throw new Error(`Invalid Android emulator display size: ${JSON.stringify(size)}`);
    }
    await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "settings",
      "put",
      "system",
      "accelerometer_rotation",
      "0",
    ]);
    await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "settings",
      "put",
      "system",
      "user_rotation",
      "0",
    ]);
    await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "wm",
      "size",
      `${size.width}x${size.height}`,
    ]);
  }

  if (!page.isClosed()) {
    await expect
      .poll(() => page.evaluate(() => window.innerWidth < window.innerHeight), {
        timeout: 10_000,
        message: "Android emulator did not settle in portrait after display-size change",
      })
      .toBe(true);
    await waitForViewportFramesToSettle(page);
  }
}

export async function setAndroidEmulatorOrientation(
  page: Page,
  orientation: "portrait" | "landscape" | "auto",
): Promise<void> {
  const serialArgs = await adbArgs();
  const serial = serialArgs.at(-1) ?? "";
  if (!serial.startsWith("emulator-")) {
    throw new Error(
      `Refusing to change orientation on non-emulator device: ${serial || "unknown"}`,
    );
  }

  if (orientation === "auto") {
    await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "settings",
      "put",
      "system",
      "user_rotation",
      "0",
    ]);
    await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "settings",
      "put",
      "system",
      "accelerometer_rotation",
      "1",
    ]);
  } else {
    await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "settings",
      "put",
      "system",
      "accelerometer_rotation",
      "0",
    ]);
    await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "settings",
      "put",
      "system",
      "user_rotation",
      orientation === "landscape" ? "1" : "0",
    ]);
  }

  const expectLandscape = orientation === "landscape";
  await expect
    .poll(() => page.evaluate(() => window.innerWidth > window.innerHeight), {
      timeout: 10_000,
      message: `Android emulator did not settle in ${orientation} orientation`,
    })
    .toBe(expectLandscape);
}

export async function touchPtyTerminalAndWaitForSoftKeyboard(page: Page): Promise<void> {
  const input = page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]');
  // A previous test/cycle can leave Android's IME, DOM focus, and visualViewport
  // at three different points in their close transition. Start every activation
  // from one fully closed state instead of hiding a failed first attempt with a retry.
  await dismissSoftKeyboard(page);
  await touchPtyTerminal(page);
  await expect(input).toBeFocused({ timeout: 1_000 });
  await waitForSoftKeyboard(page);
  await waitForPtyControlsToSettleAboveKeyboard(page);
}
