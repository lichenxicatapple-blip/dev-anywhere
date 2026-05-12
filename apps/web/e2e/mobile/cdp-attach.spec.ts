// L4 烟雾用例: 验证 CDP 通道立得起来, 模拟器 Chrome 真能加载页面.
import { mobileBaseUrl, test, expect } from "../fixtures/cdp";

test.describe("L4 mobile / CDP attach", () => {
  // emuPage 是 worker-shared, 其他 spec 跑后 url 已经偏离根. 这里自己 goto 重置.
  test.beforeEach(async ({ emuPage }) => {
    await emuPage.goto(`${mobileBaseUrl}/`);
  });

  test("connects to Android emulator Chrome and loads dev server", async ({ emuPage }) => {
    await expect(emuPage).toHaveURL(new RegExp(`^${mobileBaseUrl.replace(/[/.]/g, "\\$&")}`));
    const title = await emuPage.title();
    expect(typeof title).toBe("string");
  });

  test("viewport reports emulator innerWidth (411px portrait)", async ({ emuPage }) => {
    const iw = await emuPage.evaluate(() => window.innerWidth);
    // Medium_Phone_API_36.1 portrait = 411 CSS px. landscape 会到 914, 也接受.
    expect([411, 914]).toContain(iw);
  });
});
