// localRuntime fixture 的烟雾用例: relay+proxy 真起得来, 拆得干净.
import { expect, test } from "../fixtures/local-runtime";

test.describe("localRuntime fixture", () => {
  test("brings up isolated relay and registers a proxy", async ({ localRuntime }) => {
    const r = await fetch(`${localRuntime.relayHttpUrl}/api/proxies`);
    expect(r.ok).toBe(true);
    const proxies = (await r.json()) as Array<{ id: string }>;
    expect(proxies.length).toBeGreaterThan(0);
    expect(localRuntime.relayUrl).toMatch(/^ws:\/\/localhost:\d+$/);
    expect(localRuntime.profileHome).toMatch(/\/tmp\/da-e2e-/);
  });
});
