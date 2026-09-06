import { expect, test } from "@playwright/test";
import type { PreviewSummary } from "@dev-anywhere/shared";
import { installFakeRelay, selectFakeProxy, sentFakeRelayMessages } from "../helpers";

const sources = [
  // Leave room for platform font differences in the narrow desktop sidebar.
  { previewId: "short-url", url: "http://[::1]" },
  {
    previewId: "long-url",
    url: `http://localhost:5173/${"long-preview-path/".repeat(12)}`,
  },
];

for (const viewport of [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
]) {
  test(`preview subtitles stay compact and truncate safely at ${viewport.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await installFakeRelay(page);
    await selectFakeProxy(page);

    await expect
      .poll(async () =>
        (await sentFakeRelayMessages(page)).find((msg) => msg.type === "preview_list_request"),
      )
      .toBeTruthy();
    const request = (await sentFakeRelayMessages(page)).find(
      (msg) => msg.type === "preview_list_request",
    )!;
    const previews: PreviewSummary[] = sources.map(({ previewId, url }) => ({
      previewId,
      name: previewId,
      source: { kind: "local", url },
      tunnelProvider: "cloudflare",
      state: "ready",
      publicUrl: `https://${previewId}.trycloudflare.com`,
      createdAt: 1,
      updatedAt: 1,
    }));
    await page.evaluate((message) => window.__devAnywhereE2E!.socket!.emitJson(message), {
      type: "preview_list_response",
      requestId: request.requestId,
      scope: request.scope,
      epoch: "preview-layout",
      revision: 0,
      previews,
    });

    for (const { previewId, url } of sources) {
      const row = page.locator(`[data-preview-id="${previewId}"]:visible`);
      await expect(row).toBeVisible();
      await row.scrollIntoViewIfNeeded();
      const source = row.getByTitle(url, { exact: true });
      const status = row.getByText("可访问", { exact: true });
      const menu = row.getByRole("button", { name: "预览操作" });
      await expect(status).toBeInViewport();
      await expect(menu).toBeInViewport();

      const geometry = await source.evaluate((node) => {
        const text = document.createRange();
        text.selectNodeContents(node);
        const sourceBox = node.getBoundingClientRect();
        const separatorBox = node.nextElementSibling!.getBoundingClientRect();
        const status = node.nextElementSibling!.nextElementSibling!;
        const statusBox = status.getBoundingClientRect();
        const row = node.closest('[data-slot="preview-row"]')!;
        const rowBox = row.getBoundingClientRect();
        const menuBox = row
          .querySelector('[data-slot="preview-row-menu-trigger"]')!
          .getBoundingClientRect();
        return {
          sourceWidth: node.clientWidth,
          sourceScrollWidth: node.scrollWidth,
          textToSeparatorGap: separatorBox.left - text.getBoundingClientRect().right,
          sourceToSeparatorGap: separatorBox.left - sourceBox.right,
          separatorToStatusGap: statusBox.left - separatorBox.right,
          statusFits: status.scrollWidth <= status.clientWidth,
          statusToMenuGap: menuBox.left - statusBox.right,
          menuRightInset: rowBox.right - menuBox.right,
          textOverflow: getComputedStyle(node).textOverflow,
          overflow: getComputedStyle(node).overflowX,
        };
      });

      expect(geometry.sourceToSeparatorGap).toBeGreaterThanOrEqual(0);
      expect(geometry.sourceToSeparatorGap).toBeLessThanOrEqual(8);
      expect(geometry.separatorToStatusGap).toBeGreaterThanOrEqual(0);
      expect(geometry.separatorToStatusGap).toBeLessThanOrEqual(8);
      expect(geometry.statusFits).toBe(true);
      expect(geometry.statusToMenuGap).toBeGreaterThanOrEqual(0);
      expect(geometry.menuRightInset).toBeGreaterThanOrEqual(0);
      if (previewId === "short-url") {
        expect(geometry.sourceScrollWidth).toBeLessThanOrEqual(geometry.sourceWidth + 1);
        expect(geometry.textToSeparatorGap).toBeGreaterThanOrEqual(0);
        expect(geometry.textToSeparatorGap).toBeLessThanOrEqual(8);
      } else {
        expect(geometry.sourceWidth).toBeGreaterThan(0);
        expect(geometry.sourceScrollWidth).toBeGreaterThan(geometry.sourceWidth);
        expect(geometry.textOverflow).toBe("ellipsis");
        expect(geometry.overflow).toBe("hidden");
        await menu.click();
        await expect(page.locator('[data-slot="preview-row-menu"]')).toBeVisible();
      }
    }
  });
}
