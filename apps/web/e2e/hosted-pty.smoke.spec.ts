// hostedPty fixture 烟雾用例: relay+proxy 起来 → client 注册 → 选 proxy → 创 hosted PTY 会话.
import { expect, test } from "./fixtures/hosted-pty";

test.describe("hostedPty fixture", () => {
  test("creates a hosted PTY session via relay control protocol", async ({ hostedPty }) => {
    expect(hostedPty.sessionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hostedPty.proxyId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(hostedPty.cwd).toBe("/tmp");
  });
});
