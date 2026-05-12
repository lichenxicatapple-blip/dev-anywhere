// 钉死 localRuntime / hostedPty / jsonMode 三个 fixture 自身的最小契约:
// 起 backend + 通过 relay control 协议建 session.
// 别处 spec 假设 fixture 工作时靠这条 spec 守门.
import { expect, test } from "../fixtures/sessions";

test.describe("e2e fixtures contract", () => {
  test("localRuntime brings up isolated relay and registers a proxy", async ({ localRuntime }) => {
    const r = await fetch(`${localRuntime.relayHttpUrl}/api/proxies`);
    expect(r.ok).toBe(true);
    const proxies = (await r.json()) as Array<{ id: string }>;
    expect(proxies.length).toBeGreaterThan(0);
    expect(localRuntime.relayUrl).toMatch(/^ws:\/\/localhost:\d+$/);
    expect(localRuntime.profileHome).toMatch(/\/tmp\/da-e2e-/);
  });

  test("hostedPty creates a hosted PTY session via relay control protocol", async ({
    hostedPty,
  }) => {
    expect(hostedPty.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hostedPty.proxyId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hostedPty.cwd).toBe("/tmp");
  });

  test("jsonMode creates a json-mode session via relay control protocol", async ({ jsonMode }) => {
    expect(jsonMode.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(jsonMode.proxyId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(jsonMode.mode).toBe("json");
    expect(jsonMode.cwd).toBe("/tmp");
  });
});
