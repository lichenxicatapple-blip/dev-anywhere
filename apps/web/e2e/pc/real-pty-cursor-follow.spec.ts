import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { BASE_URL } from "../helpers";
import { spawnSessionViaRelay, type SessionViaRelay } from "../fixtures/relay-control";

const enabled = process.env.DEV_ANYWHERE_REAL_PTY_CURSOR_FOLLOW === "1";
const relayUrl = process.env.DEV_ANYWHERE_REAL_RELAY_URL ?? "ws://127.0.0.1:3100";

async function openSession(page: Page, session: SessionViaRelay) {
  await page.goto(`${BASE_URL}/#/`);
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
  await page.goto(`${BASE_URL}/#/chat/${session.sessionId}?mode=pty`);
  const entry = page.locator(
    `[data-slot="pty-keepalive-entry"][data-session-id="${session.sessionId}"]`,
  );
  await expect(entry).toHaveAttribute("data-active", "true");
  await expect(entry.locator('[data-slot="chat-pty-view"]')).toHaveAttribute(
    "data-connection-ready",
    "true",
  );
}

async function cursor(page: Page, sessionId: string) {
  return page.evaluate((id) => {
    const term = window.__ccTestPtyTerminals?.get(id);
    const entry = document.querySelector(
      `[data-slot="pty-keepalive-entry"][data-session-id="${id}"][data-active="true"]`,
    );
    const container = entry?.querySelector<HTMLElement>('[data-slot="pty-terminal"]');
    const screen = entry?.querySelector<HTMLElement>(".xterm-screen");
    if (!term || !container || !screen || screen.clientWidth === 0) return null;
    const x = (term.buffer.active.cursorX * screen.clientWidth) / term.cols;
    return {
      column: term.buffer.active.cursorX,
      scrollLeft: container.scrollLeft,
      visible: x >= container.scrollLeft && x < container.scrollLeft + container.clientWidth,
    };
  }, sessionId);
}

test.use({ viewport: { width: 360, height: 704 }, hasTouch: true });

test("keeps real Kimi redraws stable and follows real Kimi and Shell long input", async ({
  page,
}, testInfo) => {
  test.skip(!enabled, "set DEV_ANYWHERE_REAL_PTY_CURSOR_FOLLOW=1 to use local Kimi and Shell");
  test.skip(
    !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(relayUrl),
    "requires a local Relay",
  );
  test.setTimeout(90_000);
  const cwd = resolve("../../artifacts/kimi-cursor-follow/empty-project");
  await mkdir(cwd, { recursive: true });
  const sessions: SessionViaRelay[] = [];
  const observations: unknown[] = [];
  await page.addInitScript(() => localStorage.setItem("dev_anywhere_pty_scroll_trace", "1"));
  try {
    const kimi = await spawnSessionViaRelay(
      { relayUrl },
      { kind: "agent", mode: "pty", provider: "kimi", cwd, cols: 80, rows: 29 },
    );
    sessions.push(kimi);
    await openSession(page, kimi);
    const text = () =>
      page.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", kimi.sessionId);
    await expect.poll(text).toMatch(/Trust this folder|No session yet/);
    if ((await text()).includes("Trust this folder")) {
      kimi.send({ type: "remote_input_raw", sessionId: kimi.sessionId, data: "\r" });
    }
    await expect.poll(text).toContain("No session yet");
    await expect.poll(async () => (await cursor(page, kimi.sessionId))?.column).toBe(5);
    await page.evaluate((id) => {
      const el = document.querySelector<HTMLElement>(
        `[data-slot="pty-keepalive-entry"][data-session-id="${id}"][data-active="true"] [data-slot="pty-terminal"]`,
      )!;
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft")!;
      const samples: number[] = [];
      Object.defineProperty(el, "scrollLeft", {
        configurable: true,
        get: () => descriptor.get!.call(el) as number,
        set: (value: number) => {
          descriptor.set!.call(el, value);
          samples.push(el.scrollLeft);
        },
      });
      Object.assign(window, { __realCursorScrollSamples: samples });
    }, kimi.sessionId);
    // Each character causes a real pi-tui redraw of the 80-column input border. The input caret
    // stays in the left half; none of those redraws may pan the viewport to the right edge.
    for (let index = 0; index < 20; index += 1) {
      kimi.send({ type: "remote_input_raw", sessionId: kimi.sessionId, data: "x" });
      await expect.poll(async () => (await cursor(page, kimi.sessionId))?.column).toBe(6 + index);
    }
    const samples = await page.evaluate(
      () =>
        (window as unknown as { __realCursorScrollSamples: number[] }).__realCursorScrollSamples,
    );
    observations.push({ phase: "kimi-short-input-redraws", samples });
    expect(samples.filter((left) => left > 1)).toEqual([]);
    kimi.send({ type: "remote_input_raw", sessionId: kimi.sessionId, data: "x".repeat(40) });
    await expect.poll(async () => (await cursor(page, kimi.sessionId))?.column).toBe(65);
    await expect
      .poll(async () => (await cursor(page, kimi.sessionId))?.scrollLeft ?? 0)
      .toBeGreaterThan(100);
    expect((await cursor(page, kimi.sessionId))?.visible).toBe(true);
    observations.push({ phase: "kimi-long-input", ...(await cursor(page, kimi.sessionId)) });
    await page.screenshot({ path: testInfo.outputPath("real-kimi-long-input.png") });
    kimi.send({ type: "remote_input_raw", sessionId: kimi.sessionId, data: "\x01" });
    await expect.poll(async () => (await cursor(page, kimi.sessionId))?.column).toBe(5);
    await expect.poll(async () => (await cursor(page, kimi.sessionId))?.scrollLeft).toBe(0);
    kimi.send({ type: "remote_input_raw", sessionId: kimi.sessionId, data: "\x05\x15" });

    const shell = await spawnSessionViaRelay(
      { relayUrl },
      { kind: "terminal", mode: "pty", cols: 160, rows: 29 },
    );
    sessions.push(shell);
    await openSession(page, shell);
    shell.send({
      type: "remote_input_raw",
      sessionId: shell.sessionId,
      data: "exec /bin/zsh -f\r",
    });
    shell.send({
      type: "remote_input_raw",
      sessionId: shell.sessionId,
      data: "PROMPT='> '; RPROMPT=''\r",
    });
    await expect.poll(async () => (await cursor(page, shell.sessionId))?.column).toBe(2);
    await page
      .locator(
        `[data-slot="pty-keepalive-entry"][data-session-id="${shell.sessionId}"] [data-slot="pty-terminal"]`,
      )
      .click();
    await page.keyboard.type(`echo ${"x".repeat(75)}`);
    await expect.poll(async () => (await cursor(page, shell.sessionId))?.column).toBe(82);
    await expect
      .poll(async () => (await cursor(page, shell.sessionId))?.scrollLeft ?? 0)
      .toBeGreaterThan(100);
    expect((await cursor(page, shell.sessionId))?.visible).toBe(true);
    observations.push({ phase: "shell-long-input", ...(await cursor(page, shell.sessionId)) });
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await cursor(page, shell.sessionId))?.column).toBe(2);
    await expect.poll(async () => (await cursor(page, shell.sessionId))?.scrollLeft).toBe(0);
    observations.push({ phase: "shell-enter", ...(await cursor(page, shell.sessionId)) });
    await page.screenshot({ path: testInfo.outputPath("real-shell-after-enter.png") });
  } finally {
    await testInfo.attach("real-scroll-debug", {
      body: JSON.stringify(
        await page.evaluate(() => ({
          snapshot: window.__devAnywherePtyDebug?.(),
          trace: window.__devAnywherePtyScrollTrace,
          url: location.href,
        })),
      ),
      contentType: "application/json",
    });
    await page.screenshot({ path: testInfo.outputPath("before-session-cleanup.png") });
    await testInfo.attach("real-cursor-observations", {
      body: JSON.stringify(observations),
      contentType: "application/json",
    });
    for (const session of sessions.reverse()) await session.terminate();
  }
});

test("preserves real Codex input, streaming output, manual pan, and reconnect", async ({
  browser,
  page,
}, testInfo) => {
  test.skip(!enabled, "set DEV_ANYWHERE_REAL_PTY_CURSOR_FOLLOW=1 to use local Codex");
  test.skip(
    !/^ws:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(relayUrl),
    "requires a local Relay",
  );
  test.setTimeout(180_000);
  const cwd = resolve("../../artifacts/codex-cursor-follow/empty-project");
  await mkdir(cwd, { recursive: true });
  const session = await spawnSessionViaRelay(
    { relayUrl },
    { kind: "agent", mode: "pty", provider: "codex", cwd, cols: 80, rows: 29 },
  );
  const observations: unknown[] = [{ phase: "session", sessionId: session.sessionId }];
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const entrySelector = `[data-slot="pty-keepalive-entry"][data-session-id="${session.sessionId}"][data-active="true"]`;
  const terminal = page.locator(`${entrySelector} [data-slot="pty-terminal"]`);
  const terminalText = (viewer: Page = page) =>
    viewer.evaluate((id) => window.__ccTest?.pty.serialize(id) ?? "", session.sessionId);
  const inspect = (viewer: Page = page) => cursor(viewer, session.sessionId);
  const send = (data: string) =>
    session.send({ type: "remote_input_raw", sessionId: session.sessionId, data });
  await page.addInitScript(() => localStorage.setItem("dev_anywhere_pty_scroll_trace", "1"));

  try {
    await openSession(page, session);
    await expect
      .poll(() => terminalText(), { timeout: 30_000 })
      .toMatch(/OpenAI Codex|Do you trust|Update available/i);
    if (/Update available|Skip until next version/.test(await terminalText())) send("2\r");
    await expect.poll(() => terminalText()).toMatch(/OpenAI Codex|Do you trust/i);
    if (/Do you trust/.test(await terminalText())) send("1\r");
    await expect.poll(() => terminalText()).toContain("OpenAI Codex");
    await expect.poll(async () => (await inspect())?.column).toBe(2);
    const header = (await terminalText()).match(/OpenAI Codex[^\r\n]*/)?.[0];
    observations.push({ phase: "ready", header, ...(await inspect()) });
    await terminal.click();

    await page.evaluate(
      ({ selector, sessionId }) => {
        const container = document.querySelector<HTMLElement>(
          `${selector} [data-slot="pty-terminal"]`,
        )!;
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "scrollLeft")!;
        const samples: number[] = [];
        const record = () => samples.push(container.scrollLeft);
        // Cover native scrolling and every browser paint while Codex streams, not just final
        // coordinates or controller assignments made during Playwright keyboard actions.
        container.addEventListener("scroll", record);
        window.__ccTestPtyTerminals?.get(sessionId)?.onRender(record);
        const samplePaint = () => {
          if (!container.isConnected) return;
          record();
          requestAnimationFrame(samplePaint);
        };
        requestAnimationFrame(samplePaint);
        Object.defineProperty(container, "scrollLeft", {
          configurable: true,
          get: () => descriptor.get!.call(container) as number,
          set: (value: number) => {
            descriptor.set!.call(container, value);
            samples.push(container.scrollLeft);
          },
        });
        Object.assign(window, { __realCursorScrollSamples: samples });
      },
      { selector: entrySelector, sessionId: session.sessionId },
    );
    for (let index = 0; index < 20; index += 1) {
      await page.keyboard.type("x");
      await expect.poll(async () => (await inspect())?.column).toBe(3 + index);
    }
    const shortSamples = await page.evaluate(
      () =>
        (window as unknown as { __realCursorScrollSamples: number[] }).__realCursorScrollSamples,
    );
    observations.push({ phase: "short-input-redraws", samples: shortSamples });
    expect(shortSamples.length).toBeGreaterThan(0);
    expect(shortSamples.filter((left) => left > 1)).toEqual([]);

    await page.keyboard.type("x".repeat(40));
    await expect.poll(async () => (await inspect())?.column).toBe(62);
    await expect.poll(async () => (await inspect())?.scrollLeft ?? 0).toBeGreaterThan(100);
    expect((await inspect())?.visible).toBe(true);
    // Positive control: the same recorder must see the intentional long-input pan.
    expect(
      await page.evaluate(() =>
        Math.max(
          ...(window as unknown as { __realCursorScrollSamples: number[] })
            .__realCursorScrollSamples,
        ),
      ),
    ).toBeGreaterThan(100);
    observations.push({ phase: "long-input", ...(await inspect()) });
    await page.screenshot({ path: testInfo.outputPath("codex-mobile-long-input.png") });

    await page.keyboard.press("Home");
    await expect.poll(async () => (await inspect())?.column).toBe(2);
    await expect.poll(async () => (await inspect())?.scrollLeft).toBe(0);
    await page.keyboard.press("End");
    await expect.poll(async () => (await inspect())?.column).toBe(62);
    await expect.poll(async () => (await inspect())?.scrollLeft ?? 0).toBeGreaterThan(100);
    observations.push({ phase: "home-end", ...(await inspect()) });

    // Partial review leaves the caret visible near the right edge. Passive Codex repaints must
    // keep that position; the next local edit explicitly resumes cursor following.
    await terminal.hover();
    await page.mouse.wheel(-120, 0);
    await expect.poll(async () => (await inspect())?.scrollLeft ?? 999).toBeLessThan(220);
    const partialLeft = (await inspect())!.scrollLeft;
    expect(partialLeft).toBeGreaterThan(100);
    expect((await inspect())?.visible).toBe(true);
    await page.evaluate(async (id) => {
      const term = window.__ccTestPtyTerminals!.get(id)!;
      for (let frame = 0; frame < 60; frame += 1) {
        term.refresh(0, term.rows - 1);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    }, session.sessionId);
    expect((await inspect())?.scrollLeft).toBe(partialLeft);
    observations.push({ phase: "partial-manual-pan-preserved", ...(await inspect()) });
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await inspect())?.column).toBe(61);
    await expect
      .poll(async () => (await inspect())?.scrollLeft ?? 0)
      .toBeGreaterThan(partialLeft + 50);
    expect((await inspect())?.visible).toBe(true);
    await page.keyboard.press("End");
    await expect.poll(async () => (await inspect())?.column).toBe(62);

    // Fully moving the caret out of view has the same ownership rule.
    await page.mouse.wheel(-1000, 0);
    await expect.poll(async () => (await inspect())?.scrollLeft).toBe(0);
    observations.push({ phase: "manual-pan-preserved", ...(await inspect()) });
    for (let index = 0; index < 3; index += 1) {
      await page.keyboard.press("ArrowLeft");
      await expect.poll(async () => (await inspect())?.column).toBe(61 - index);
      await expect.poll(async () => (await inspect())?.visible).toBe(true);
    }
    observations.push({ phase: "local-navigation-resumes-follow", ...(await inspect()) });
    await page.keyboard.press("Home");
    await expect.poll(async () => (await inspect())?.column).toBe(2);
    await page.keyboard.press("End");
    await expect.poll(async () => (await inspect())?.column).toBe(62);
    await expect.poll(async () => (await inspect())?.scrollLeft ?? 0).toBeGreaterThan(100);
    await page.keyboard.press("Control+u");
    await expect.poll(async () => (await inspect())?.column).toBe(2);
    await expect.poll(async () => (await inspect())?.scrollLeft).toBe(0);

    const prompt =
      "Terminal display test. Do not use tools or access files. Write 40 numbered lines, each saying stable terminal output. Then join the words CODEX CURSOR DONE with underscores on the final line.";
    await page.keyboard.type(prompt, { delay: 10 });
    await page.evaluate(() => {
      (
        window as unknown as { __realCursorScrollSamples: number[] }
      ).__realCursorScrollSamples.length = 0;
    });
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await inspect())?.scrollLeft).toBe(0);
    await expect.poll(() => terminalText(), { timeout: 120_000 }).toContain("CODEX_CURSOR_DONE");
    await expect.poll(async () => (await inspect())?.column).toBe(2);
    const outputSamples = await page.evaluate(
      () =>
        (window as unknown as { __realCursorScrollSamples: number[] }).__realCursorScrollSamples,
    );
    observations.push({ phase: "real-model-output", samples: outputSamples, ...(await inspect()) });
    expect(outputSamples.length).toBeGreaterThan(1);
    expect(outputSamples.filter((left) => left > 1)).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath("codex-mobile-output.png") });

    const desktopPage = await desktop.newPage();
    await openSession(desktopPage, session);
    await expect.poll(() => terminalText(desktopPage)).toContain("CODEX_CURSOR_DONE");
    expect((await inspect(desktopPage))?.visible).toBe(true);
    expect((await inspect(desktopPage))?.scrollLeft).toBe(0);
    await desktopPage.screenshot({ path: testInfo.outputPath("codex-desktop-output.png") });
    observations.push({ phase: "desktop", ...(await inspect(desktopPage)) });

    await page.reload();
    await expect(page.locator(`${entrySelector} [data-slot="chat-pty-view"]`)).toHaveAttribute(
      "data-connection-ready",
      "true",
    );
    await expect.poll(() => terminalText()).toContain("CODEX_CURSOR_DONE");
    await expect.poll(async () => (await inspect())?.scrollLeft).toBe(0);
    expect((await inspect())?.visible).toBe(true);
    observations.push({ phase: "mobile-reconnect", ...(await inspect()) });
  } finally {
    try {
      const report = {
        observations,
        terminal: await terminalText(),
        scrollTrace: await page.evaluate(() => window.__devAnywherePtyScrollTrace),
      };
      await writeFile(
        testInfo.outputPath("codex-observations.json"),
        JSON.stringify(report, null, 2),
      );
      await testInfo.attach("codex-observations", {
        body: JSON.stringify(report),
        contentType: "application/json",
      });
      await page.screenshot({ path: testInfo.outputPath("codex-before-cleanup.png") });
    } finally {
      await session.terminate();
      await desktop.close();
    }
  }
});
