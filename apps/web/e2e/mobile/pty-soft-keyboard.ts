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
