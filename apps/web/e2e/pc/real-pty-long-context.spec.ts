// 长上下文 PTY 渲染的真实环境冒烟测试。
//
// 跑这个测试需要：
//   1. 本地 dev server 已启动（pnpm --filter @dev-anywhere/web dev）
//   2. 一个真实的 proxy + relay 在线
//   3. 提供一个累积了大量历史输出的 PTY 会话 ID
//
// 因为依赖具体环境 + 真实会话 ID（默认绑定到 catli 本机的某个会话），
// 缺省 `test.describe.skip` 不会触发。要跑请显式设：
//
//   DEV_ANYWHERE_REAL_PTY_LONG_CONTEXT=1 \
//     bash scripts/web-e2e.sh e2e/real-pty-long-context.spec.ts --project=desktop
//
// 注意：必须经 scripts/web-e2e.sh 入口跑——它会切到 Node 22。Playwright 1.52
// 在 Node 25 下会无声 hang，是已知 Node/Playwright 互斥。
//
// 想换会话 ID：
//   DEV_ANYWHERE_REAL_PTY_LONG_CONTEXT_SESSION=<your-session-id>
//
// 验证点（针对用户报的 bug 类型）：
//   1) 终端挂载 + buffer 有真实长上下文（serialize 长度 > 4000）
//   2) buffer 不含 U+FFFD（CJK 解码 / atlas 拆错的指纹）
//   3) buffer 中段没有超过 viewport rows 的连续空行（"屏幕中段空一段"探针）
//   4) PtyDebugSnapshot.spacerDrift 接近 0（spacer/host 几何自洽）
//   5) 滚顶 → 滚底往返：scrollTop 收敛回初始值附近，无累积漂移
//   6) 中段位置 scroll 往返：抓 viewportY → 滚开 → 滚回，viewportY 完全相等
//   7) 反向滚动 10 次 + 10 次后 scrollTop 不超过一格漂移
//   8) 强制 atlas 重建（forceRedraw）前后 serialize 不变——无 GPU 残留
import { expect, test, type Page } from "@playwright/test";

const enabled = process.env.DEV_ANYWHERE_REAL_PTY_LONG_CONTEXT === "1";
const SESSION_ID =
  process.env.DEV_ANYWHERE_REAL_PTY_LONG_CONTEXT_SESSION ?? "fL85Y4-dnMPUqiBWvO7RO";
const BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";
const MIN_LONG_CONTEXT_CHARS = 4000;

test.describe("Real PTY long-context smoke", () => {
  test.skip(!enabled, "set DEV_ANYWHERE_REAL_PTY_LONG_CONTEXT=1 to run against a live PTY session");
  test.setTimeout(120_000);

  test("mounts long-context terminal with substantive buffer and no garbling", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    await waitForLongContextReady(page);

    const dump = await readSerialize(page);
    expect(
      dump.length,
      `serialize 长度 ${dump.length} < ${MIN_LONG_CONTEXT_CHARS}——会话太短，不算长上下文，换个 session ID 测`,
    ).toBeGreaterThanOrEqual(MIN_LONG_CONTEXT_CHARS);

    // U+FFFD = "REPLACEMENT CHARACTER"，绝大多数情况下出现意味着 UTF-8 解码错位
    // 或 atlas 缓存把双字节 cell 拆错——是用户报的"乱码"最可观测的指纹。
    const replacementCount = countOccurrences(dump, "\u{FFFD}");
    expect(replacementCount, `serialize 含 U+FFFD ${replacementCount} 处，CJK 渲染错位`).toBe(0);

    // viewport 不应"上下有字、中间整段空"——找最长的中间空行 run，超过 viewport 行数视为可疑
    const metrics = await readMetrics(page);
    expect(metrics, "metrics 为空说明 terminal 还没真正挂上").not.toBeNull();
    const viewportLines = metrics ? metrics.rows : 24;
    const longestBlankRunInMiddle = findLongestMiddleBlankRun(dump);
    expect(
      longestBlankRunInMiddle,
      `dump 中间最长空白连续行 ${longestBlankRunInMiddle} > viewport rows ${viewportLines}，疑似帧丢失`,
    ).toBeLessThanOrEqual(viewportLines);

    // PtyDebugSnapshot.spacerDrift = 当前 spacer.height - expectedSpacerHeight。
    // 几何自洽时应该是 0；不为 0 说明 updateSpacer 漏写或读 cell 尺寸错位。
    const drift = await readSpacerDrift(page);
    expect(drift, "spacerDrift 偏离 0 超过 1px——几何不自洽").not.toBeNull();
    expect(Math.abs(drift ?? 0)).toBeLessThanOrEqual(1);

    // viewport ∩ host 重叠比例。<1 即"可见视口里有空白带"——blank-render bug 的最直接特征。
    // 阈值 0.99 容忍亚像素级别的 round-off,实质要求"基本完全覆盖"。
    const coverage = await readViewportHostCoverage(page);
    expect(coverage, "viewportHostCoverage 不可读 / null").not.toBeNull();
    expect(
      coverage ?? 0,
      `viewport-host 覆盖率 ${coverage} < 0.99,可见区出现空白带 (host 卡 stale 或 spacer 几何错位)`,
    ).toBeGreaterThanOrEqual(0.99);
  });

  test("scrolling to top reveals history then scrolling back re-engages follow", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    const terminal = await waitForLongContextReady(page);

    const initialScrollTop = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);
    const initialScrollHeight = await terminal.evaluate((el) => (el as HTMLElement).scrollHeight);
    expect(initialScrollHeight, "scrollHeight 没累积，session 太短不适合本测试").toBeGreaterThan(800);

    // 滚到最顶
    await terminal.evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect.poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop)).toBe(0);

    // 等 xterm 把 viewport 同步到最早行
    await expect
      .poll(() =>
        page.evaluate((sid) => {
          const term = window.__ccTestPtyTerminals?.get(sid);
          if (!term) return null;
          return term.buffer.active.viewportY;
        }, SESSION_ID),
      )
      .not.toBeNull();

    // 回到底部
    await page.locator('[data-slot="back-to-bottom"]').click({ trial: false }).catch(async () => {
      await terminal.evaluate((el) => {
        const node = el as HTMLElement;
        node.scrollTop = node.scrollHeight - node.clientHeight;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
    });

    await expect
      .poll(() =>
        terminal.evaluate((el) => {
          const node = el as HTMLElement;
          return node.scrollTop + node.clientHeight >= node.scrollHeight - 16;
        }),
      )
      .toBeTruthy();

    // 走一遭后 scrollTop 接近原始 follow 状态
    expect(
      Math.abs(
        (await terminal.evaluate((el) => (el as HTMLElement).scrollTop)) - initialScrollTop,
      ),
    ).toBeLessThanOrEqual(64);
  });

  test("mid-buffer wheel roundtrip: viewportY recovers exactly", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    const terminal = await waitForLongContextReady(page);

    // 先滚到中段
    const midScrollTop = await terminal.evaluate((el) => {
      const node = el as HTMLElement;
      const target = Math.floor((node.scrollHeight - node.clientHeight) / 2);
      node.scrollTop = target;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
      return node.scrollTop;
    });

    // 抓中段时的 viewportY
    await expect.poll(() => readViewportY(page)).not.toBeNull();
    const midViewportY = await readViewportY(page);

    // 滚到顶再回到中段
    await terminal.evaluate((el) => {
      const node = el as HTMLElement;
      node.scrollTop = 0;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect.poll(() => terminal.evaluate((el) => (el as HTMLElement).scrollTop)).toBe(0);

    await terminal.evaluate((el, target) => {
      const node = el as HTMLElement;
      node.scrollTop = target;
      node.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, midScrollTop);

    // 回到中段后 viewportY 应该等于第一次抓的值
    await expect.poll(() => readViewportY(page)).toBe(midViewportY);
  });

  test("reverse wheel scroll does not accumulate drift", async ({ page }) => {
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    const terminal = await waitForLongContextReady(page);
    const metrics = await readMetrics(page);
    const cellH =
      metrics && metrics.rows > 0 ? Math.round(metrics.screenHeight / metrics.rows) : 20;

    const initialScrollTop = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);
    // 上滚 10 次 + 下滚 10 次，每次 200 像素。dispatchEvent 是 Locator 上 wrapper，
    // 但 wheel 事件 deltaY 需要直接 evaluate 注入。
    for (let i = 0; i < 10; i += 1) {
      await terminal.evaluate((el) =>
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: -200, bubbles: true, cancelable: true })),
      );
    }
    for (let i = 0; i < 10; i += 1) {
      await terminal.evaluate((el) =>
        el.dispatchEvent(new WheelEvent("wheel", { deltaY: 200, bubbles: true, cancelable: true })),
      );
    }

    const finalScrollTop = await terminal.evaluate((el) => (el as HTMLElement).scrollTop);
    expect(
      Math.abs(finalScrollTop - initialScrollTop),
      `反向滚动后 scrollTop 漂移 ${Math.abs(finalScrollTop - initialScrollTop)} > cellH ${cellH}`,
    ).toBeLessThanOrEqual(cellH);
  });

  test("force redraw via debug API does not crash and reports a non-empty terminal", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/#/chat/${SESSION_ID}?mode=pty`);
    await waitForLongContextReady(page);

    // forceRedraw 等价于 term.refresh(0, rows-1)。无法断言"前后内容一致"——live session
    // 一直在产出新数据。能做的是：API 存在 + 调用不抛 + 报告至少一个 terminal 被刷。
    const refreshed = await page.evaluate(() => {
      const api = window.__devAnywherePtyRenderDebug;
      if (!api) return -1;
      try {
        return api.forceRedraw();
      } catch {
        return -2;
      }
    });
    expect(refreshed, "forceRedraw 抛异常").not.toBe(-2);
    expect(refreshed, "__devAnywherePtyRenderDebug 没挂上 window").not.toBe(-1);
    expect(refreshed, "forceRedraw 没刷新到任何 terminal").toBeGreaterThanOrEqual(1);

    // 在等一短帧后页面没崩
    await page.waitForTimeout(100);
    await expect(page.locator('[data-slot="pty-terminal"]')).toBeVisible();
    expect((await readSerialize(page)).length).toBeGreaterThanOrEqual(MIN_LONG_CONTEXT_CHARS);
  });
});

// === helpers ===

async function waitForLongContextReady(page: Page) {
  const terminal = page.locator('[data-slot="pty-terminal"]');
  await expect(terminal).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-slot="pty-host"] .xterm')).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      () => page.evaluate((sid) => window.__ccTest?.pty.serialize(sid)?.length ?? 0, SESSION_ID),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  return terminal;
}

async function readSerialize(page: Page): Promise<string> {
  return page.evaluate((sid) => window.__ccTest?.pty.serialize(sid) ?? "", SESSION_ID);
}

interface PtyMetrics {
  fontSize: number | undefined;
  cols: number;
  rows: number;
  screenWidth: number;
  screenHeight: number;
}

async function readMetrics(page: Page): Promise<PtyMetrics | null> {
  return page.evaluate((sid) => window.__ccTest?.pty.metrics(sid) ?? null, SESSION_ID);
}

async function readViewportY(page: Page): Promise<number | null> {
  return page.evaluate((sid) => {
    const term = window.__ccTestPtyTerminals?.get(sid);
    return term ? term.buffer.active.viewportY : null;
  }, SESSION_ID);
}

async function readSpacerDrift(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const provider = window.__devAnywherePtyDebug;
    if (!provider) return null;
    const snap = provider();
    return snap?.spacerDrift ?? null;
  });
}

async function readViewportHostCoverage(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const provider = window.__devAnywherePtyDebug;
    if (!provider) return null;
    const snap = provider();
    return snap?.viewportHostCoverage ?? null;
  });
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

// 在 dump 的"非空-空-非空"夹击下，统计最长空行 run 的长度。
// 文末连续空行不算（buffer 末尾天然留白），开头非空行之前也不算。
function findLongestMiddleBlankRun(dump: string): number {
  const rows = dump.split("\n");
  let firstNonEmpty = -1;
  let lastNonEmpty = -1;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].trim().length > 0) {
      if (firstNonEmpty < 0) firstNonEmpty = i;
      lastNonEmpty = i;
    }
  }
  if (firstNonEmpty < 0 || lastNonEmpty <= firstNonEmpty) return 0;

  let longest = 0;
  let current = 0;
  for (let i = firstNonEmpty; i <= lastNonEmpty; i += 1) {
    if (rows[i].trim().length === 0) {
      current += 1;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}
