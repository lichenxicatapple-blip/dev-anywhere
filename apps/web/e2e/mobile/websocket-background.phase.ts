import { chromium, type Page } from "@playwright/test";
import { installFakeRelay } from "../helpers";

const CDP_ENDPOINT = process.env.MOBILE_CDP_ENDPOINT ?? "http://127.0.0.1:9222";
const VITE_BASE_URL = process.env.MOBILE_VITE_BASE_URL ?? "http://127.0.0.1:5174";
const SESSION_ID = "json-sess";
const TURN_ID = "mobile-background-stream";
const RESULT_PREFIX = "BACKGROUND_PHASE_RESULT=";

function phaseLog(message: string): void {
  process.stderr.write(`[background-phase] ${message}\n`);
}

type RelayCounts = {
  close: number;
  open: number;
  ping: number;
};

type StreamEmission = {
  focused: boolean;
  revision: number;
  visibility: DocumentVisibilityState;
};

type BackgroundResumeAudit = {
  deadBaseline?: RelayCounts;
  deadEmissionStart?: number;
  documentId: string;
  emissions: StreamEmission[];
  emitNext(): void;
  healthyBaseline: RelayCounts;
  healthyEmissionStart: number;
  intervalId: number;
  originalSocket: unknown;
  preDeadSocket?: unknown;
  revision: number;
  route: string;
};

type BackgroundResumeWindow = Window & {
  __backgroundResumeAudit?: BackgroundResumeAudit;
};

async function connectToMobilePage(): Promise<Page> {
  phaseLog(`connecting to ${CDP_ENDPOINT}`);
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page =
    pages.find((candidate) => candidate.url().startsWith(VITE_BASE_URL)) ?? pages.at(0) ?? null;
  if (!page) throw new Error("Android Chrome has no page target");
  phaseLog(`connected to ${page.url()}`);
  return page;
}

async function setup(): Promise<Record<string, unknown>> {
  const page = await connectToMobilePage();
  page.on("console", (message) => {
    if (message.type() === "error") phaseLog(`console error: ${message.text()}`);
  });
  page.on("pageerror", (error) => phaseLog(`page error: ${error.message}`));
  phaseLog("installing fake relay");
  // This phase runs through tsx in a short-lived child process. esbuild annotates
  // serialized function declarations with __name; define the helper before the
  // fake-relay init script executes in a fresh browser document.
  await page.addInitScript({
    content:
      'globalThis.__name ??= (target, value) => Object.defineProperty(target, "name", { configurable: true, value });',
  });
  await installFakeRelay(page);
  phaseLog("loading a fresh document");
  await page.goto(`${VITE_BASE_URL}/?websocket-background=${Date.now()}`);
  phaseLog("binding the fake proxy and opening chat");
  await page.evaluate(() => {
    localStorage.setItem("dev_anywhere_proxyId", "proxy-1");
    localStorage.removeItem("dev-anywhere:last-chat-route");
    sessionStorage.removeItem("dev-anywhere:route-restored");
    sessionStorage.removeItem("dev-anywhere:restored-target");
  });
  await page.goto(`${VITE_BASE_URL}/#/chat/${SESSION_ID}?mode=json`);
  await page.reload();
  try {
    await page.locator('[data-slot="input-bar"][data-mode="json"]').waitFor({
      state: "visible",
      timeout: 15_000,
    });
  } catch (error) {
    const snapshot = await page.evaluate(() => ({
      body: document.body.innerText.slice(0, 1_000),
      events: window.__devAnywhereE2E?.events ?? null,
      fakeRelayInstalled: Boolean(window.__devAnywhereFakeRelayInstalled),
      proxyId: localStorage.getItem("dev_anywhere_proxyId"),
      url: location.href,
    }));
    throw new Error(`Chat setup did not become ready: ${JSON.stringify(snapshot)}`, {
      cause: error,
    });
  }
  phaseLog("chat input is visible");

  const documentId = `background-resume-${Date.now()}`;
  await page.evaluate(
    ({ id, sessionId, turnId }) => {
      const currentWindow = window as BackgroundResumeWindow;
      const readCounts = (): RelayCounts => {
        const events = window.__devAnywhereE2E?.events ?? [];
        return {
          close: events.filter((event) => event === "relay:close").length,
          open: events.filter((event) => event === "relay:open").length,
          ping: events.filter((event) => event === "relay:send:latency_web_relay_ping").length,
        };
      };
      const audit: BackgroundResumeAudit = {
        documentId: id,
        emissions: [],
        emitNext() {
          audit.revision += 1;
          audit.emissions.push({
            focused: document.hasFocus(),
            revision: audit.revision,
            visibility: document.visibilityState,
          });
          window.__devAnywhereE2E?.socket?.emitJson({
            seq: Date.now(),
            sessionId,
            timestamp: Date.now(),
            source: "proxy",
            version: "1",
            type: "assistant_message",
            payload: {
              turnId,
              revision: audit.revision,
              text: `后台持续更新 ${audit.revision}`,
              status: "streaming",
            },
          });
        },
        healthyBaseline: readCounts(),
        healthyEmissionStart: 0,
        intervalId: 0,
        originalSocket: window.__devAnywhereE2E?.socket ?? null,
        revision: 0,
        route: location.href,
      };
      currentWindow.__backgroundResumeAudit = audit;
      audit.emitNext();
      audit.healthyEmissionStart = audit.emissions.length;
    },
    { id: documentId, sessionId: SESSION_ID, turnId: TURN_ID },
  );
  await page.getByText("后台持续更新 1").waitFor({ state: "visible", timeout: 10_000 });
  phaseLog("first streaming revision is visible");
  await page.evaluate(() => {
    const audit = (window as BackgroundResumeWindow).__backgroundResumeAudit;
    if (!audit) throw new Error("background resume audit was not installed");
    audit.intervalId = window.setInterval(() => audit.emitNext(), 1_000);
  });

  return page.evaluate(() => {
    const audit = (window as BackgroundResumeWindow).__backgroundResumeAudit;
    if (!audit) throw new Error("background resume audit was not installed");
    const events = window.__devAnywhereE2E?.events ?? [];
    return {
      documentId: audit.documentId,
      route: audit.route,
      counts: {
        close: events.filter((event) => event === "relay:close").length,
        open: events.filter((event) => event === "relay:open").length,
        ping: events.filter((event) => event === "relay:send:latency_web_relay_ping").length,
      },
    };
  });
}

async function inspectHealthyAndPrepareDead(): Promise<Record<string, unknown>> {
  const page = await connectToMobilePage();
  await page.waitForFunction(
    () => {
      const audit = (window as BackgroundResumeWindow).__backgroundResumeAudit;
      const pingCount =
        window.__devAnywhereE2E?.events.filter(
          (event) => event === "relay:send:latency_web_relay_ping",
        ).length ?? 0;
      return Boolean(audit && pingCount > audit.healthyBaseline.ping);
    },
    undefined,
    { timeout: 10_000 },
  );
  // A matching pong must still own the same socket after the replacement deadline passes.
  await page.waitForTimeout(2_200);

  const state = await page.evaluate(() => {
    const audit = (window as BackgroundResumeWindow).__backgroundResumeAudit;
    if (!audit) throw new Error("the original page document was replaced");
    const readCounts = (): RelayCounts => {
      const events = window.__devAnywhereE2E?.events ?? [];
      return {
        close: events.filter((event) => event === "relay:close").length,
        open: events.filter((event) => event === "relay:open").length,
        ping: events.filter((event) => event === "relay:send:latency_web_relay_ping").length,
      };
    };
    const counts = readCounts();
    const backgroundEmissions = audit.emissions
      .slice(audit.healthyEmissionStart)
      .filter((emission) => !emission.focused).length;
    const latestText = `后台持续更新 ${audit.revision}`;
    const sameSocket = audit.originalSocket === window.__devAnywhereE2E?.socket;

    // Keep the explicit post-resume revision stable until the assertion observes it. Otherwise
    // the one-second stream interval can replace revision N with N+1 before the CDP client starts
    // polling, turning a healthy updating page into a permanent wait for stale text.
    window.clearInterval(audit.intervalId);
    audit.emitNext();
    window.__devAnywhereE2E?.setRelayLivenessPongEnabled(false);
    audit.preDeadSocket = window.__devAnywhereE2E?.socket ?? null;
    audit.deadBaseline = readCounts();
    audit.deadEmissionStart = audit.emissions.length;

    return {
      backgroundEmissions,
      closeDelta: counts.close - audit.healthyBaseline.close,
      documentId: audit.documentId,
      latestText,
      latestVisible: document.body.innerText.includes(latestText),
      openDelta: counts.open - audit.healthyBaseline.open,
      pingDelta: counts.ping - audit.healthyBaseline.ping,
      postResumeText: `后台持续更新 ${audit.revision}`,
      route: location.href,
      sameSocket,
    };
  });
  await page.getByText(String(state.postResumeText)).waitFor({ state: "visible", timeout: 10_000 });
  // Keep the old socket completely silent for the dead-connection phase. A normal relay frame is
  // valid liveness evidence, so restarting the stream here would race (and correctly cancel) the
  // two-second probe that is supposed to replace a genuinely half-open connection.
  return { ...state, postResumeVisible: true };
}

async function inspectDead(): Promise<Record<string, unknown>> {
  const page = await connectToMobilePage();
  try {
    await page.waitForFunction(
      () => {
        const audit = (window as BackgroundResumeWindow).__backgroundResumeAudit;
        const baseline = audit?.deadBaseline;
        if (!audit || !baseline) return false;
        const events = window.__devAnywhereE2E?.events ?? [];
        const counts = {
          close: events.filter((event) => event === "relay:close").length,
          open: events.filter((event) => event === "relay:open").length,
          ping: events.filter((event) => event === "relay:send:latency_web_relay_ping").length,
        };
        return (
          counts.ping > baseline.ping &&
          counts.close > baseline.close &&
          counts.open > baseline.open
        );
      },
      undefined,
      { timeout: 12_000 },
    );
  } catch (error) {
    const diagnostics = await page.evaluate(() => {
      const audit = (window as BackgroundResumeWindow).__backgroundResumeAudit;
      const events = window.__devAnywhereE2E?.events ?? [];
      return {
        auditPresent: Boolean(audit),
        baseline: audit?.deadBaseline ?? null,
        counts: {
          close: events.filter((event) => event === "relay:close").length,
          open: events.filter((event) => event === "relay:open").length,
          ping: events.filter((event) => event === "relay:send:latency_web_relay_ping").length,
        },
        documentId: audit?.documentId ?? null,
        route: location.href,
      };
    });
    throw new Error(`Dead-socket recovery timed out: ${JSON.stringify(diagnostics)}`, {
      cause: error,
    });
  }

  // A new WebSocket `open` precedes proxy rebind, history replay, and the React commit that restores
  // the composer. Assert the user-visible recovery point instead of snapshotting that async phase
  // in the same task as the raw socket counters.
  await page.locator('[data-slot="input-bar"][data-mode="json"]').waitFor({
    state: "visible",
    timeout: 10_000,
  });

  const state = await page.evaluate(() => {
    const audit = (window as BackgroundResumeWindow).__backgroundResumeAudit;
    const baseline = audit?.deadBaseline;
    if (!audit || !baseline || audit.deadEmissionStart === undefined) {
      throw new Error("the original page document or dead-socket baseline was lost");
    }
    const events = window.__devAnywhereE2E?.events ?? [];
    const counts = {
      close: events.filter((event) => event === "relay:close").length,
      open: events.filter((event) => event === "relay:open").length,
      ping: events.filter((event) => event === "relay:send:latency_web_relay_ping").length,
    };
    const backgroundEmissions = audit.emissions
      .slice(audit.deadEmissionStart)
      .filter((emission) => !emission.focused).length;
    const socketReplaced = audit.preDeadSocket !== window.__devAnywhereE2E?.socket;

    window.__devAnywhereE2E?.setRelayLivenessPongEnabled(true);
    audit.emitNext();
    window.clearInterval(audit.intervalId);

    return {
      backgroundEmissions,
      closeDelta: counts.close - baseline.close,
      documentId: audit.documentId,
      inputVisible: Boolean(document.querySelector('[data-slot="input-bar"][data-mode="json"]')),
      openDelta: counts.open - baseline.open,
      pingDelta: counts.ping - baseline.ping,
      postReconnectText: `后台持续更新 ${audit.revision}`,
      route: location.href,
      socketReplaced,
    };
  });
  await page
    .getByText(String(state.postReconnectText))
    .waitFor({ state: "visible", timeout: 10_000 });
  return { ...state, postReconnectVisible: true };
}

async function main(): Promise<void> {
  const phase = process.argv[2];
  let result: Record<string, unknown>;
  if (phase === "setup") result = await setup();
  else if (phase === "inspect-healthy") result = await inspectHealthyAndPrepareDead();
  else if (phase === "inspect-dead") result = await inspectDead();
  else throw new Error(`Unknown background phase: ${String(phase)}`);

  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`);
}

void main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
