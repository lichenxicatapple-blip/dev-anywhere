// jsonMode fixture 烟雾用例: relay+proxy → client 协议 → 创 mode=json 的 session, worker spawn claude.
import { expect, test } from "../fixtures/json-mode";

test.describe("jsonMode fixture", () => {
  test("creates a json-mode session via relay control protocol", async ({ jsonMode }) => {
    expect(jsonMode.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(jsonMode.proxyId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(jsonMode.mode).toBe("json");
    expect(jsonMode.cwd).toBe("/tmp");
  });
});
