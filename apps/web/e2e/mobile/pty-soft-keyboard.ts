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
  for (let attempt = 0; attempt < 10 && !node; attempt += 1) {
    await execFileAsync("adb", [...serialArgs, "shell", "uiautomator", "dump", dumpPath]);
    const { stdout: hierarchy } = await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "cat",
      dumpPath,
    ]);
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
    if (!node) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!bounds) {
    const visibleNodes = [...lastHierarchy.matchAll(/<node\b[^>]*>/g)]
      .map(([value]) => value)
      .filter((value) => /(?:text|content-desc|hint)="[^"]+"/.test(value))
      .slice(0, 8)
      .join("\n");
    throw new Error(
      `Android accessibility target missing: ${label}${visibleNodes ? `\nVisible nodes:\n${visibleNodes}` : ""}`,
    );
  }
  const [, left, top, right, bottom] = bounds.map(Number);
  const x = Math.round((left + right) / 2);
  const y = Math.round((top + bottom) / 2);

  await execFileAsync("adb", [...serialArgs, "shell", "input", "tap", `${x}`, `${y}`]);
}

export async function touchPtyTerminal(page: Page): Promise<void> {
  await tapWithAdb(page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'));
}

export async function waitForSoftKeyboard(page: Page): Promise<void> {
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
}

export async function dismissSoftKeyboard(_page: Page): Promise<void> {
  const serialArgs = await adbArgs();
  if (!(await isNativeSoftKeyboardVisible(serialArgs))) return;

  await execFileAsync("adb", [...serialArgs, "shell", "input", "keyevent", "4"]);
  await expect
    .poll(async () => !(await isNativeSoftKeyboardVisible(serialArgs)), {
      timeout: 10_000,
      message: "Android soft keyboard did not close between tests",
    })
    .toBe(true);
}

export async function touchPtyTerminalAndWaitForSoftKeyboard(page: Page): Promise<void> {
  await touchPtyTerminal(page);
  await expect(
    page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'),
  ).toBeFocused();
  await waitForSoftKeyboard(page);
}
