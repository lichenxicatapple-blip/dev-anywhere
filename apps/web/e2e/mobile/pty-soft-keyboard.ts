import { expect, type Locator, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

export async function tapWithAdb(locator: Locator): Promise<void> {
  const label = await locator.getAttribute("aria-label");
  if (!label) throw new Error("Android tap target needs an aria-label");
  const serialArgs = await adbArgs();
  const dumpPath = "/sdcard/dev-anywhere-window.xml";
  let node: string | undefined;
  for (let attempt = 0; attempt < 10 && !node; attempt += 1) {
    await execFileAsync("adb", [...serialArgs, "shell", "uiautomator", "dump", dumpPath]);
    const { stdout: hierarchy } = await execFileAsync("adb", [
      ...serialArgs,
      "shell",
      "cat",
      dumpPath,
    ]);
    node = [...hierarchy.matchAll(/<node\b[^>]*>/g)]
      .map(([value]) => value)
      .find(
        (value) =>
          value.includes(`text="${label}"`) ||
          value.includes(`content-desc="${label}"`) ||
          value.includes(`hint="${label}"`),
      );
    if (!node) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  if (!bounds) throw new Error(`Android accessibility target missing: ${label}`);
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

export async function touchPtyTerminalAndWaitForSoftKeyboard(page: Page): Promise<void> {
  await touchPtyTerminal(page);
  await expect(
    page.locator('[data-slot="pty-host"] textarea[aria-label="Terminal input"]'),
  ).toBeFocused();
  await waitForSoftKeyboard(page);
}
