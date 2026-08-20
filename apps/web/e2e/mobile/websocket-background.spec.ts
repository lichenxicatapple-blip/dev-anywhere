import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  backgroundAndroidChrome,
  foregroundAndroidChrome,
  isAndroidChromeForeground,
} from "../fixtures/cdp";

const execFileAsync = promisify(execFile);
const WEB_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PHASE_SCRIPT = fileURLToPath(new URL("./websocket-background.phase.ts", import.meta.url));
const RESULT_PREFIX = "BACKGROUND_PHASE_RESULT=";

type PhaseResult = Record<string, boolean | number | string | null>;

async function runPhase(phase: "setup" | "inspect-healthy" | "inspect-dead") {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("pnpm", ["exec", "tsx", PHASE_SCRIPT, phase], {
      cwd: WEB_ROOT,
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    }));
  } catch (error) {
    const executionError = error as Error & { stderr?: string; stdout?: string };
    throw new Error(
      `Background phase ${phase} failed:\n${executionError.stdout ?? ""}\n${executionError.stderr ?? executionError.message}`,
      { cause: error },
    );
  }
  const resultLine = stdout.split("\n").findLast((line) => line.startsWith(RESULT_PREFIX));
  if (!resultLine) throw new Error(`Background phase ${phase} returned no result:\n${stdout}`);
  return JSON.parse(resultLine.slice(RESULT_PREFIX.length)) as PhaseResult;
}

async function waitForBackgroundWindow(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 6_500));
}

test.describe("L4 mobile / background WebSocket liveness", () => {
  test.setTimeout(90_000);

  test("keeps the same updating page with a healthy socket and reconnects only a dead socket", async () => {
    const setup = await runPhase("setup");
    expect(setup.documentId).toMatch(/^background-resume-/);
    expect(setup.route).toContain("/#/chat/json-sess?mode=json");
    expect(setup.counts).toMatchObject({ close: 0, ping: 0 });
    expect((setup.counts as unknown as { open: number }).open).toBeGreaterThan(0);

    await backgroundAndroidChrome();
    await expect.poll(isAndroidChromeForeground).toBe(false);
    await waitForBackgroundWindow();
    await foregroundAndroidChrome();
    await expect.poll(isAndroidChromeForeground).toBe(true);

    const healthy = await runPhase("inspect-healthy");
    expect(healthy.documentId).toBe(setup.documentId);
    expect(healthy.route).toBe(setup.route);
    expect(healthy.backgroundEmissions).toBeGreaterThan(0);
    expect(healthy.pingDelta).toBe(1);
    expect(healthy.openDelta).toBe(0);
    expect(healthy.closeDelta).toBe(0);
    expect(healthy.sameSocket).toBe(true);
    expect(healthy.latestVisible).toBe(true);
    expect(healthy.postResumeVisible).toBe(true);

    await backgroundAndroidChrome();
    await expect.poll(isAndroidChromeForeground).toBe(false);
    await waitForBackgroundWindow();
    await foregroundAndroidChrome();
    await expect.poll(isAndroidChromeForeground).toBe(true);

    const recovered = await runPhase("inspect-dead");
    expect(recovered.documentId).toBe(setup.documentId);
    expect(recovered.route).toBe(setup.route);
    // The first background phase proves healthy streaming continues. The dead phase must be fully
    // silent; otherwise an ordinary inbound frame legitimately proves the socket is still alive.
    expect(recovered.backgroundEmissions).toBe(0);
    expect(recovered.pingDelta).toBe(1);
    expect(recovered.openDelta).toBe(1);
    expect(recovered.closeDelta).toBe(1);
    expect(recovered.socketReplaced).toBe(true);
    expect(recovered.inputVisible).toBe(true);
    expect(recovered.postReconnectVisible).toBe(true);
  });
});
