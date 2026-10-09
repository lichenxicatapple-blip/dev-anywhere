import { copyFile, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { spawnSessionViaRelay, type SessionViaRelay } from "../fixtures/relay-control";

// Run against an isolated local Relay/Proxy with a changing-frame H.264 MP4 (> 10 MB,
// at least 50 seconds). No media requests or provider output are mocked.
// DEV_ANYWHERE_REAL_VIDEO_PREVIEW=1 DEV_ANYWHERE_REAL_RELAY_URL=ws://127.0.0.1:3112
// DEV_ANYWHERE_REAL_VIDEO_FILE=/tmp/video.mp4 WEB_BASE_URL=http://127.0.0.1:5182
// pnpm exec playwright test --project=device-pc-real real-video-preview.spec.ts
const enabled = process.env.DEV_ANYWHERE_REAL_VIDEO_PREVIEW === "1";
const relayUrl = process.env.DEV_ANYWHERE_REAL_RELAY_URL ?? "ws://127.0.0.1:3112";
const videoFile = process.env.DEV_ANYWHERE_REAL_VIDEO_FILE ?? "";
const baseUrl = process.env.WEB_BASE_URL ?? "http://127.0.0.1:5182";

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function openSession(page: Page, session: SessionViaRelay): Promise<void> {
  await page.goto(`${baseUrl}/#/`);
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await page.locator('[data-slot="proxy-switcher-trigger"]').click();
  }
  await page
    .locator(`[data-slot="proxy-item"][data-proxy-id="${session.proxyId}"]:visible`)
    .last()
    .click();
  await expect(
    page.locator(`[data-slot="session-row"][data-session-id="${session.sessionId}"]:visible`),
  ).toBeVisible();
  await page.goto(`${baseUrl}/#/chat/${session.sessionId}?mode=pty`);
  await expect(page.locator('[data-slot="chat-pty-view"]')).toHaveAttribute(
    "data-connection-ready",
    "true",
  );
}

async function pathPoint(page: Page, sessionId: string, path: string) {
  return page.evaluate(
    ({ sessionId, path }) => {
      const term = window.__ccTestPtyTerminals?.get(sessionId);
      const screen = term?.element?.querySelector(".xterm-screen");
      if (!term || !screen) return null;
      const rect = screen.getBoundingClientRect();
      for (let row = 0; row < term.rows; row += 1) {
        const line = term.buffer.active
          .getLine(term.buffer.active.viewportY + row)
          ?.translateToString(true);
        // Wait for printf output, not the still-echoing shell command containing the path.
        const column = line?.trim() === path ? line.indexOf(path) : -1;
        if (column < 0) continue;
        return {
          x: rect.left + ((column + 3.5) * rect.width) / term.cols,
          y: rect.top + ((row + 0.5) * rect.height) / term.rows,
        };
      }
      return null;
    },
    { sessionId, path },
  );
}

for (const narrow of [false, true]) {
  test.describe(narrow ? "mobile viewport layout (desktop Chromium)" : "desktop Chromium", () => {
    test.use({
      viewport: narrow ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      hasTouch: narrow,
    });

    test("plays a real Shell video, seeks with Range, and releases it on close", async ({
      page,
      context,
    }, testInfo) => {
      test.setTimeout(90_000);
      test.skip(!enabled, "set DEV_ANYWHERE_REAL_VIDEO_PREVIEW=1 for the real media stack");
      expect(relayUrl).toMatch(/^ws:\/\/(?:localhost|127\.0\.0\.1):\d+$/);
      expect(baseUrl).toMatch(/^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/);
      expect(isAbsolute(videoFile), "DEV_ANYWHERE_REAL_VIDEO_FILE must be absolute").toBe(true);
      const fileSize = (await stat(videoFile)).size;
      expect(fileSize, "the fixture must exceed browser metadata buffering").toBeGreaterThan(
        10 * 1024 * 1024,
      );
      const session = await spawnSessionViaRelay(
        { relayUrl },
        { kind: "terminal", mode: "pty", cols: 100, rows: 30 },
      );
      let reopenDirectory: string | undefined;
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const responses: Array<{ status: number; range: string; requestedRange: string }> = [];
      page.on("response", (response) => {
        if (!response.url().includes("/api/remote-files/")) return;
        responses.push({
          status: response.status(),
          range: response.headers()["content-range"] ?? "",
          requestedRange: response.request().headers().range ?? "",
        });
      });
      try {
        await openSession(page, session);
        const relativePath = `./${basename(videoFile)}`;
        session.send({
          type: "remote_input_raw",
          sessionId: session.sessionId,
          // A fixed short prompt keeps a later long temporary cwd from horizontally
          // scrolling the media path away while its touch coordinates are sampled.
          data: `PS1='VIDEO> '; cd ${quoteShell(dirname(videoFile))}; printf '\\033[2J\\033[H%s\\n' ${quoteShell(relativePath)}\r`,
        });
        await expect.poll(() => pathPoint(page, session.sessionId, relativePath)).not.toBeNull();

        // Keep the far end unbuffered without intercepting or replacing HTTP responses.
        const cdp = await context.newCDPSession(page);
        const mediaRequestIds = new Set<string>();
        const canceledMediaRequests: string[] = [];
        cdp.on("Network.requestWillBeSent", (event) => {
          if (event.request.url.includes("/api/remote-files/"))
            mediaRequestIds.add(event.requestId);
        });
        cdp.on("Network.loadingFailed", (event) => {
          if (mediaRequestIds.has(event.requestId) && event.canceled) {
            canceledMediaRequests.push(event.requestId);
          }
        });
        await cdp.send("Network.enable");
        await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
        await cdp.send("Network.emulateNetworkConditions", {
          offline: false,
          latency: 25,
          downloadThroughput: 700_000,
          uploadThroughput: 1_000_000,
        });
        const point = (await pathPoint(page, session.sessionId, relativePath))!;
        if (narrow) {
          await page.touchscreen.tap(point.x, point.y);
        } else {
          await page.keyboard.down("Meta");
          await page.mouse.click(point.x, point.y);
          await page.keyboard.up("Meta");
        }
        const dialog = page.locator('[data-slot="video-preview-dialog"]');
        const video = dialog.locator("video");
        await expect(dialog).toBeVisible();
        await expect
          .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState), {
            timeout: 20_000,
          })
          .toBeGreaterThanOrEqual(1);
        expect(
          await video.evaluate((element) => (element as HTMLVideoElement).videoWidth),
        ).toBeGreaterThan(0);
        await expect(video).toHaveAttribute("controls", "");
        expect(
          await video.evaluate((element) => (element as HTMLVideoElement).duration),
        ).toBeGreaterThan(50);
        await video.evaluate((element) => (element as HTMLVideoElement).play());
        await expect
          .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime))
          .toBeGreaterThan(0.3);
        await expect
          .poll(() =>
            video.evaluate(
              (element) => (element as HTMLVideoElement).getVideoPlaybackQuality().totalVideoFrames,
            ),
          )
          .toBeGreaterThan(2);
        const buffered = await video.evaluate((element) => {
          const media = element as HTMLVideoElement;
          return Array.from({ length: media.buffered.length }, (_, index) => [
            media.buffered.start(index),
            media.buffered.end(index),
          ]);
        });
        expect(buffered.some(([start, end]) => start! <= 45 && end! >= 45)).toBe(false);
        // An existing media URL must continue to identify the original file after Shell cd.
        session.send({
          type: "remote_input_raw",
          sessionId: session.sessionId,
          data: "cd /tmp; printf 'VIDEO_''CWD_CHANGED\\n'\r",
        });
        await expect
          .poll(() =>
            page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", session.sessionId),
          )
          .toContain("VIDEO_CWD_CHANGED");
        const seekResponseStart = responses.length;
        await video.evaluate((element) => {
          (element as HTMLVideoElement).currentTime = 45;
        });
        await expect
          .poll(() => video.evaluate((element) => (element as HTMLVideoElement).currentTime), {
            timeout: 20_000,
          })
          .toBeGreaterThan(45.3);
        await expect
          .poll(() =>
            responses
              .slice(seekResponseStart)
              .some(
                (response) =>
                  response.status === 206 &&
                  /^bytes=[1-9]\d*-/.test(response.requestedRange) &&
                  new RegExp(`^bytes [1-9]\\d*-\\d+/${fileSize}$`).test(response.range),
              ),
          )
          .toBe(true);
        expect(await video.evaluate((element) => (element as HTMLVideoElement).error)).toBeNull();
        if (narrow) {
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          ).toBe(true);
          const box = (await dialog.boundingBox())!;
          expect(box.width).toBeLessThanOrEqual(390);
          expect(box.height).toBeLessThanOrEqual(844);
        }
        await page.screenshot({ path: testInfo.outputPath("video-playing-after-seek.png") });
        await testInfo.attach("real-media-responses", {
          body: JSON.stringify({ fileSize, bufferedBeforeSeek: buffered, responses }, null, 2),
          contentType: "application/json",
        });
        const detachedVideo = (await video.elementHandle())!;
        const cancellationsBeforeClose = canceledMediaRequests.length;
        await page.getByRole("button", { name: "关闭视频预览", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect
          .poll(() =>
            detachedVideo.evaluate((element) => {
              const media = element as HTMLVideoElement;
              return {
                paused: media.paused,
                src: media.getAttribute("src"),
                readyState: media.readyState,
                networkState: media.networkState,
                bufferedRanges: media.buffered.length,
              };
            }),
          )
          .toEqual({ paused: true, src: null, readyState: 0, networkState: 0, bufferedRanges: 0 });
        await expect
          .poll(() => canceledMediaRequests.length)
          .toBeGreaterThan(cancellationsBeforeClose);

        // Closing the player ends the URL's binding. A new click of the same relative
        // filename must resolve against the current cwd, rather than reuse the old URL.
        reopenDirectory = await mkdtemp(join(tmpdir(), "dev-anywhere-video-reopen-"));
        const reopenedFile = join(reopenDirectory, basename(videoFile));
        await copyFile(videoFile, reopenedFile);
        session.send({
          type: "remote_input_raw",
          sessionId: session.sessionId,
          data: `cd ${quoteShell(reopenDirectory)}; printf '\\033[2J\\033[H%s\\nVIDEO_''REOPEN_READY\\n' ${quoteShell(relativePath)}\r`,
        });
        await expect
          .poll(() =>
            page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", session.sessionId),
          )
          .toContain("VIDEO_REOPEN_READY");
        await expect.poll(() => pathPoint(page, session.sessionId, relativePath)).not.toBeNull();
        const reopenPoint = (await pathPoint(page, session.sessionId, relativePath))!;
        if (narrow) {
          await page.touchscreen.tap(reopenPoint.x, reopenPoint.y);
        } else {
          await page.keyboard.down("Meta");
          await page.mouse.click(reopenPoint.x, reopenPoint.y);
          await page.keyboard.up("Meta");
        }
        await expect(dialog.locator('[data-slot="dialog-description"]')).toHaveText(
          await realpath(reopenedFile),
        );
        await expect
          .poll(() => video.evaluate((element) => (element as HTMLVideoElement).readyState), {
            timeout: 20_000,
          })
          .toBeGreaterThanOrEqual(1);
        await page.getByRole("button", { name: "关闭视频预览", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        // Browser network ERR_ABORTED while removing src is expected; page exceptions are not.
        expect(pageErrors).toEqual([]);
        await cdp.detach();
      } finally {
        await session.terminate();
        if (reopenDirectory) await rm(reopenDirectory, { recursive: true, force: true });
      }
    });
  });
}
