import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "../fixtures/local-runtime";
import { spawnSessionViaRelay, type SessionViaRelay } from "../fixtures/relay-control";
import {
  startPtyBenchmarkGateway,
  startPtyBenchmarkWeb,
  type DownlinkStats,
} from "../fixtures/pty-sync-benchmark-runtime";

const ENABLED = process.env.DEV_ANYWHERE_PTY_SYNC_BENCHMARK === "1";
const CLIENT_COUNTS = (process.env.PTY_SYNC_BENCH_CLIENTS ?? "1")
  .split(",")
  .map(Number)
  .filter((value) => value === 1 || value === 3 || value === 5);
const DOWNLINK_BYTES_PER_SECOND = Number(process.env.PTY_SYNC_BENCH_DOWNLINK_BPS ?? 300 * 1024);
const LATENCY_MS = Number(process.env.PTY_SYNC_BENCH_LATENCY_MS ?? 25);
const READY_TIMEOUT_MS = Number(process.env.PTY_SYNC_BENCH_READY_TIMEOUT_MS ?? 240_000);
const WATERMARK_TIMEOUT_MS = Number(process.env.PTY_SYNC_BENCH_WATERMARK_TIMEOUT_MS ?? 90_000);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WORKLOAD_PATH = resolve(REPO_ROOT, "apps/web/e2e/fixtures/pty-sync-workload.mjs");
let snapshotProbeSequence = 0;

interface SnapshotObservation {
  requestId: string;
  outputSeq: number;
  bytes: number;
  at: number;
  matching: boolean;
}

interface BrowserTrace {
  startedAt: number;
  relayExtensions: string | null;
  subscribes: Array<{ requestId: string; at: number }>;
  snapshots: SnapshotObservation[];
  binarySeqs: number[];
  watermarkSeq: number | null;
  watermarkReceivedAt: number | null;
  readyAt: number | null;
  paintedAt: number | null;
}

interface ClientMetric {
  client: number;
  subscribeCount: number;
  retryCount: number;
  snapshotCount: number;
  matchingSnapshotCount: number;
  nonMatchingSnapshotCount: number;
  nonMatchingSnapshotBytes: number;
  totalMatchingSnapshotBytes: number;
  appliedSnapshotBytes: number;
  snapshotOutputSeq: number;
  watermarkOutputSeq: number;
  replayedFrameCount: number;
  sequenceGapCount: number;
  sequenceDuplicateCount: number;
  subscribeToSnapshotMs: number;
  subscribeToReadyMs: number;
  subscribeToWatermarkReceiveMs: number;
  subscribeToWatermarkPaintMs: number;
  readyToWatermarkPaintMs: number;
}

interface BenchmarkMetric {
  schemaVersion: 2;
  status: "complete";
  recordedAt: string;
  gitCommit: string;
  scenario: {
    cols: 179;
    rows: 37;
    seedLines: 5000;
    targetFps: 38;
    browserClients: number;
    downlinkBytesPerSecond: number;
    latencyMs: number;
  };
  workload: {
    snapshotBytes: number;
    snapshotChars: number;
    snapshotOutputSeq: number;
    observedOutputFramesPerSecond: number;
  };
  downlink: DownlinkStats;
  clients: ClientMetric[];
  aggregate: {
    slowestSubscribeToPaintMs: number;
    totalSnapshotBytesReceivedByBrowsers: number;
    totalNonMatchingSnapshotBytes: number;
    totalRetries: number;
    rawSnapshotFanoutBytes: number;
    downlinkWireToRawSnapshotFanoutRatio: number;
  };
}

interface PartialClientMetric {
  client: number;
  subscribeCount: number;
  retryCount: number;
  snapshotCount: number;
  matchingSnapshotCount: number;
  nonMatchingSnapshotCount: number;
  totalMatchingSnapshotBytes: number;
  nonMatchingSnapshotBytes: number;
  latestMatchingSnapshotOutputSeq: number | null;
  watermarkOutputSeq: number | null;
  readyObserved: boolean;
  watermarkReceived: boolean;
  watermarkPainted: boolean;
  subscribeToLatestSnapshotMs: number | null;
  subscribeToReadyMs: number | null;
  subscribeToWatermarkReceiveMs: number | null;
  subscribeToWatermarkPaintMs: number | null;
}

test.describe("real PTY sync benchmark", () => {
  test.skip(
    !ENABLED,
    "set DEV_ANYWHERE_PTY_SYNC_BENCHMARK=1 to run the local full-chain benchmark",
  );
  test.describe.configure({ mode: "serial" });

  for (const clientCount of CLIENT_COUNTS.length > 0 ? CLIENT_COUNTS : [1]) {
    test(`${clientCount} browser client${clientCount === 1 ? "" : "s"}`, async ({
      browser,
      localRuntime,
    }, testInfo) => {
      test.setTimeout(READY_TIMEOUT_MS + WATERMARK_TIMEOUT_MS + 60_000);
      const token = `${Date.now().toString(36)}-${clientCount}`;
      const seedMarker = `__PTY_SYNC_SEED_READY_${token}__`;
      const watermark = `__PTY_SYNC_WATERMARK_${token}__`;
      const binarySamples: Array<{ seq: number; at: number }> = [];
      let controllerConnected = true;
      let session: SessionViaRelay | null = null;
      let gateway: Awaited<ReturnType<typeof startPtyBenchmarkGateway>> | null = null;
      let web: Awaited<ReturnType<typeof startPtyBenchmarkWeb>> | null = null;
      const contexts: BrowserContext[] = [];
      const pages: Page[] = [];
      let phase = "starting-runtime";
      let workloadMetric: BenchmarkMetric["workload"] | null = null;

      try {
        phase = "seeding-workload";
        session = await spawnSessionViaRelay(localRuntime, {
          kind: "terminal",
          mode: "pty",
          cols: 179,
          rows: 37,
        });
        const disposeBinary = session.onBinary((buffer) => {
          const frame = decodeFrame(buffer);
          if (frame && frame.sessionId === session?.sessionId) {
            binarySamples.push({ seq: frame.outputSeq, at: performance.now() });
          }
        });

        // session_create_response can beat the detached terminal worker's IPC registration. An
        // initial snapshot is the deterministic input-ready barrier; sending before it can be
        // legitimately dropped by the proxy because no PTY socket is attached yet.
        await waitForSnapshotContaining(session, "", 30_000);
        session.send({
          type: "remote_input_raw",
          sessionId: session.sessionId,
          data: `node ${shellQuote(WORKLOAD_PATH)} --seed-lines 5000 --fps 38 --token ${shellQuote(token)}\r`,
        });

        const seedSnapshot = await waitForSnapshotContaining(session, seedMarker, 30_000);
        const snapshotWire = JSON.stringify(seedSnapshot);
        const snapshotBytes = Buffer.byteLength(snapshotWire);
        expect(seedSnapshot.cols).toBe(179);
        expect(seedSnapshot.rows).toBe(37);
        expect(snapshotBytes).toBeGreaterThan(900_000);
        expect(snapshotBytes).toBeLessThan(1_250_000);

        const rateWindowStartedAt = performance.now();
        const rateWindowStartSeq = binarySamples.at(-1)?.seq ?? Number(seedSnapshot.outputSeq);
        await new Promise((resolveWait) => setTimeout(resolveWait, 2_000));
        const rateWindowEndedAt = performance.now();
        const rateWindowEndSeq = binarySamples.at(-1)?.seq ?? rateWindowStartSeq;
        const observedFps =
          ((rateWindowEndSeq - rateWindowStartSeq) * 1000) /
          (rateWindowEndedAt - rateWindowStartedAt);
        expect(observedFps).toBeGreaterThanOrEqual(30);
        expect(observedFps).toBeLessThanOrEqual(46);
        workloadMetric = {
          snapshotBytes,
          snapshotChars: String(seedSnapshot.data).length,
          snapshotOutputSeq: Number(seedSnapshot.outputSeq),
          observedOutputFramesPerSecond: round(observedFps),
        };
        disposeBinary();
        session.disconnect();
        controllerConnected = false;

        gateway = await startPtyBenchmarkGateway({
          relayPort: localRuntime.relayPort,
          downlinkBytesPerSecond: DOWNLINK_BYTES_PER_SECOND,
          latencyMs: LATENCY_MS,
        });
        web = await startPtyBenchmarkWeb(gateway.httpUrl);

        phase = "opening-browser-clients";
        for (let index = 0; index < clientCount; index += 1) {
          const context = await browser.newContext({
            viewport: { width: 1280, height: 800 },
          });
          contexts.push(context);
          await installBrowserTrace(context, session.sessionId, watermark);
          const page = await context.newPage();
          pages.push(page);
        }

        await Promise.all(
          pages.map((page) =>
            page.goto(`${web!.baseUrl}/#/chat/${session!.sessionId}?mode=pty`, {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            }),
          ),
        );

        await Promise.all(
          pages.map((page) =>
            expect
              .poll(() => readBrowserTrace(page).then((trace) => trace.subscribes.length), {
                timeout: 30_000,
              })
              .toBeGreaterThan(0),
          ),
        );
        phase = "waiting-for-ready";
        await Promise.all(
          pages.map((page) =>
            expect(page.locator('[data-slot="chat-pty-view"]')).toHaveAttribute(
              "data-connection-ready",
              "true",
              { timeout: READY_TIMEOUT_MS },
            ),
          ),
        );

        // This marker is emitted only after every client reports snapshot replay ready. It is an
        // exact, server-generated tail watermark: seeing it painted proves the client consumed the
        // snapshot plus every contiguous live outputSeq through this point while output continues.
        phase = "waiting-for-tail-watermark";
        await sendViaPage(pages[0], {
          type: "remote_input_raw",
          sessionId: session.sessionId,
          data: `watermark ${token}\r`,
        });

        await Promise.all(
          pages.map(async (page) => {
            await expect
              .poll(() => terminalTailContains(page, session!.sessionId, watermark), {
                timeout: WATERMARK_TIMEOUT_MS,
                intervals: [50, 100, 250],
              })
              .toBe(true);
            await markPaintBarrier(page, session!.sessionId);
          }),
        );

        phase = "checking-correctness";
        const traces = await Promise.all(pages.map(readBrowserTrace));
        const clients = traces.map((trace, index) => buildClientMetric(trace, index));
        for (const [index, trace] of traces.entries()) {
          expect(trace.relayExtensions, `client ${index} relay websocket compression`).toContain(
            "permessage-deflate",
          );
        }
        for (const client of clients) {
          expect(client.sequenceGapCount, `client ${client.client} outputSeq gap`).toBe(0);
          expect(client.sequenceDuplicateCount, `client ${client.client} duplicate outputSeq`).toBe(
            0,
          );
          expect(client.watermarkOutputSeq).toBeGreaterThan(client.snapshotOutputSeq);
          expect(client.subscribeToWatermarkPaintMs).toBeGreaterThanOrEqual(
            client.subscribeToWatermarkReceiveMs,
          );
          expect(client.matchingSnapshotCount, `client ${client.client} matching snapshots`).toBe(
            1,
          );
          expect(
            client.nonMatchingSnapshotCount,
            `client ${client.client} non-matching snapshots`,
          ).toBe(0);
          expect(client.retryCount, `client ${client.client} retries`).toBe(0);
        }

        const downlink = gateway.stats();
        const rawSnapshotFanoutBytes = workloadMetric.snapshotBytes * clientCount;
        const downlinkWireToRawSnapshotFanoutRatio =
          downlink.totalBytesQueued / rawSnapshotFanoutBytes;
        // This is deliberately a conservative whole-channel bound: totalBytesQueued includes
        // control traffic and continuous binary output in addition to the compressed snapshots.
        // A missing deflate negotiation still exceeds it decisively for the ~1.05 MB workload.
        expect(downlinkWireToRawSnapshotFanoutRatio).toBeLessThan(0.65);

        const metric: BenchmarkMetric = {
          schemaVersion: 2,
          status: "complete",
          recordedAt: new Date().toISOString(),
          gitCommit: process.env.GIT_COMMIT ?? "working-tree",
          scenario: {
            cols: 179,
            rows: 37,
            seedLines: 5000,
            targetFps: 38,
            browserClients: clientCount,
            downlinkBytesPerSecond: DOWNLINK_BYTES_PER_SECOND,
            latencyMs: LATENCY_MS,
          },
          workload: workloadMetric,
          downlink,
          clients,
          aggregate: {
            slowestSubscribeToPaintMs: Math.max(
              ...clients.map((client) => client.subscribeToWatermarkPaintMs),
            ),
            totalSnapshotBytesReceivedByBrowsers: clients.reduce(
              (sum, client) =>
                sum + client.totalMatchingSnapshotBytes + client.nonMatchingSnapshotBytes,
              0,
            ),
            totalNonMatchingSnapshotBytes: clients.reduce(
              (sum, client) => sum + client.nonMatchingSnapshotBytes,
              0,
            ),
            totalRetries: clients.reduce((sum, client) => sum + client.retryCount, 0),
            rawSnapshotFanoutBytes,
            downlinkWireToRawSnapshotFanoutRatio: round(downlinkWireToRawSnapshotFanoutRatio),
          },
        };

        const json = `${JSON.stringify(metric, null, 2)}\n`;
        const outputPath = benchmarkOutputPath(clientCount);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, json);
        await testInfo.attach("pty-sync-benchmark.json", {
          body: Buffer.from(json),
          contentType: "application/json",
        });
        console.log(`PTY_SYNC_BENCHMARK_JSON ${JSON.stringify(metric)}`);
        console.log(`PTY sync benchmark written to ${outputPath}`);

        phase = "complete";
        await sendViaPage(pages[0], { type: "session_terminate", sessionId: session.sessionId });
      } catch (error) {
        const traces: BrowserTrace[] = [];
        for (const page of pages) {
          if (page.isClosed()) continue;
          const trace = await readBrowserTrace(page).catch(() => null);
          if (trace) traces.push(trace);
        }
        const partial = {
          schemaVersion: 2,
          status: "incomplete",
          recordedAt: new Date().toISOString(),
          gitCommit: process.env.GIT_COMMIT ?? "working-tree",
          phase,
          error: error instanceof Error ? error.message : String(error),
          scenario: {
            cols: 179,
            rows: 37,
            seedLines: 5000,
            targetFps: 38,
            browserClients: clientCount,
            downlinkBytesPerSecond: DOWNLINK_BYTES_PER_SECOND,
            latencyMs: LATENCY_MS,
          },
          workload: workloadMetric,
          downlink: gateway?.stats() ?? null,
          clients: traces.map(buildPartialClientMetric),
        } as const;
        const json = `${JSON.stringify(partial, null, 2)}\n`;
        const outputPath = benchmarkOutputPath(clientCount);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, json);
        console.log(`PTY_SYNC_BENCHMARK_INCOMPLETE_JSON ${JSON.stringify(partial)}`);
        console.log(`PTY sync incomplete benchmark written to ${outputPath}`);
        await testInfo
          .attach("pty-sync-benchmark-incomplete.json", {
            body: Buffer.from(json),
            contentType: "application/json",
          })
          .catch(() => undefined);
        throw error;
      } finally {
        if (controllerConnected && session) await session.terminate().catch(() => undefined);
        for (const context of contexts) await context.close().catch(() => undefined);
        await web?.destroy().catch(() => undefined);
        await gateway?.destroy().catch(() => undefined);
      }
    });
  }
});

function decodeFrame(buffer: ArrayBuffer): { sessionId: string; outputSeq: number } | null {
  const bytes = new Uint8Array(buffer);
  const sessionIdLength = bytes[0];
  if (!sessionIdLength || bytes.length < 1 + sessionIdLength + 4) return null;
  const sessionId = new TextDecoder().decode(bytes.subarray(1, 1 + sessionIdLength));
  const outputSeq = new DataView(bytes.buffer, bytes.byteOffset + 1 + sessionIdLength, 4).getUint32(
    0,
    true,
  );
  return { sessionId, outputSeq };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForSnapshotContaining(
  session: SessionViaRelay,
  marker: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  let lastData = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requestId = `pty-benchmark-seed-${++snapshotProbeSequence}`;
    const snapshot = await new Promise<Record<string, unknown>>((resolveSnapshot, reject) => {
      const timeout = setTimeout(() => {
        dispose();
        reject(new Error("seed snapshot request timed out"));
      }, 10_000);
      const dispose = session.onJson((message) => {
        if (message.type === "relay_error" && message.requestId === requestId) {
          clearTimeout(timeout);
          dispose();
          reject(new Error(`snapshot probe rejected: ${String(message.message ?? "unknown")}`));
          return;
        }
        if (message.type !== "session_snapshot" || message.requestId !== requestId) return;
        clearTimeout(timeout);
        dispose();
        resolveSnapshot(message);
      });
      session.send({ type: "session_subscribe", sessionId: session.sessionId, requestId });
    });
    if (typeof snapshot.data === "string") {
      lastData = snapshot.data;
      if (lastData.includes(marker)) return snapshot;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `seed marker was not captured in a snapshot: ${marker}; chars=${lastData.length}; tail=${JSON.stringify(lastData.slice(-1000))}`,
  );
}

async function installBrowserTrace(
  context: BrowserContext,
  sessionId: string,
  watermark: string,
): Promise<void> {
  await context.addInitScript(
    ({
      targetSessionId,
      targetWatermark,
    }: {
      targetSessionId: string;
      targetWatermark: string;
    }) => {
      const scope = window as typeof window & { __ptySyncBench?: BrowserTrace };
      const trace: BrowserTrace = {
        startedAt: performance.now(),
        relayExtensions: null,
        subscribes: [],
        snapshots: [],
        binarySeqs: [],
        watermarkSeq: null,
        watermarkReceivedAt: null,
        readyAt: null,
        paintedAt: null,
      };
      scope.__ptySyncBench = trace;
      const OriginalWebSocket = window.WebSocket;
      const decoder = new TextDecoder();

      class BenchWebSocket extends OriginalWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          const pathname = new URL(String(url), window.location.href).pathname;
          if (pathname.endsWith("/client")) {
            this.addEventListener("open", () => {
              trace.relayExtensions = this.extensions;
            });
          }
          this.addEventListener("message", (event) => {
            if (typeof event.data === "string") {
              let message: Record<string, unknown>;
              try {
                message = JSON.parse(event.data) as Record<string, unknown>;
              } catch {
                return;
              }
              if (message.type !== "session_snapshot" || message.sessionId !== targetSessionId) {
                return;
              }
              if (typeof message.requestId !== "string") return;
              const requestId = message.requestId;
              trace.snapshots.push({
                requestId,
                outputSeq: Number(message.outputSeq),
                bytes: new TextEncoder().encode(event.data).byteLength,
                at: performance.now(),
                matching: trace.subscribes.some((subscribe) => subscribe.requestId === requestId),
              });
              return;
            }
            if (!(event.data instanceof ArrayBuffer)) return;
            const bytes = new Uint8Array(event.data);
            const sidLength = bytes[0];
            if (!sidLength || bytes.length < 1 + sidLength + 4) return;
            const sid = decoder.decode(bytes.subarray(1, 1 + sidLength));
            if (sid !== targetSessionId) return;
            const seqOffset = 1 + sidLength;
            const outputSeq = new DataView(bytes.buffer, bytes.byteOffset + seqOffset, 4).getUint32(
              0,
              true,
            );
            trace.binarySeqs.push(outputSeq);
            const payload = decoder.decode(bytes.subarray(seqOffset + 4));
            if (payload.includes(targetWatermark)) {
              trace.watermarkSeq = outputSeq;
              trace.watermarkReceivedAt = performance.now();
            }
          });
        }

        override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          if (typeof data === "string") {
            try {
              const message = JSON.parse(data) as Record<string, unknown>;
              if (message.type === "session_subscribe" && message.sessionId === targetSessionId) {
                if (typeof message.requestId !== "string") return;
                trace.subscribes.push({
                  requestId: message.requestId,
                  at: performance.now(),
                });
              }
            } catch {
              // Non-JSON WebSocket messages are unrelated to PTY subscription timing.
            }
          }
          super.send(data);
        }
      }
      Object.defineProperty(window, "WebSocket", { configurable: true, value: BenchWebSocket });

      const observeReady = (): void => {
        const ready = document.querySelector<HTMLElement>(
          '[data-slot="chat-pty-view"][data-connection-ready="true"]',
        );
        if (ready && trace.readyAt === null) trace.readyAt = performance.now();
      };
      document.addEventListener("DOMContentLoaded", () => {
        observeReady();
        new MutationObserver(observeReady).observe(document.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
        });
      });
    },
    { targetSessionId: sessionId, targetWatermark: watermark },
  );
}

async function readBrowserTrace(page: Page): Promise<BrowserTrace> {
  return page.evaluate(() => {
    const trace = (window as typeof window & { __ptySyncBench?: BrowserTrace }).__ptySyncBench;
    if (!trace) throw new Error("PTY benchmark trace was not installed");
    return trace;
  });
}

async function terminalTailContains(
  page: Page,
  sessionId: string,
  marker: string,
): Promise<boolean> {
  return page.evaluate(
    ({ id, value }: { id: string; value: string }) => {
      const terminal = window.__ccTestPtyTerminals?.get(id);
      if (!terminal) return false;
      const buffer = terminal.buffer.active;
      const start = Math.max(0, buffer.length - 80);
      for (let row = start; row < buffer.length; row += 1) {
        if (buffer.getLine(row)?.translateToString(true).includes(value)) return true;
      }
      return false;
    },
    { id: sessionId, value: marker },
  );
}

async function markPaintBarrier(page: Page, sessionId: string): Promise<void> {
  await page.evaluate(
    (id: string) =>
      new Promise<void>((resolvePaint) => {
        const terminal = window.__ccTestPtyTerminals?.get(id);
        if (!terminal) throw new Error(`terminal ${id} is not registered`);
        terminal.write("", () => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const trace = (window as typeof window & { __ptySyncBench?: BrowserTrace })
                .__ptySyncBench;
              if (trace) trace.paintedAt = performance.now();
              resolvePaint();
            }),
          );
        });
      }),
    sessionId,
  );
}

async function sendViaPage(page: Page, payload: Record<string, unknown>): Promise<void> {
  const sent = await page.evaluate((message: Record<string, unknown>) => {
    const runtime = (
      globalThis as typeof globalThis & {
        __devAnywhereRelayRuntime?: { wsManagerRef?: { send: (data: string) => boolean } };
      }
    ).__devAnywhereRelayRuntime;
    return runtime?.wsManagerRef?.send(JSON.stringify(message)) ?? false;
  }, payload);
  expect(sent, `browser failed to send ${String(payload.type)}`).toBe(true);
}

function buildClientMetric(trace: BrowserTrace, client: number): ClientMetric {
  const firstSubscribe = trace.subscribes[0];
  if (!firstSubscribe) throw new Error(`client ${client} never subscribed`);
  const matchingSnapshots = trace.snapshots.filter((snapshot) => snapshot.matching);
  const appliedSnapshot = matchingSnapshots.at(-1);
  if (!appliedSnapshot) throw new Error(`client ${client} received no matching snapshot`);
  if (
    trace.watermarkSeq === null ||
    trace.watermarkReceivedAt === null ||
    trace.paintedAt === null
  ) {
    throw new Error(`client ${client} did not receive and paint the tail watermark`);
  }

  const relevantSeqs = trace.binarySeqs.filter(
    (seq) => seq > appliedSnapshot.outputSeq && seq <= trace.watermarkSeq!,
  );
  let gaps = 0;
  let duplicates = 0;
  let expected = appliedSnapshot.outputSeq + 1;
  for (const seq of relevantSeqs) {
    if (seq < expected) {
      duplicates += 1;
      continue;
    }
    if (seq > expected) gaps += seq - expected;
    expected = seq + 1;
  }
  if (expected <= trace.watermarkSeq) gaps += trace.watermarkSeq - expected + 1;

  const nonMatching = trace.snapshots.filter((snapshot) => !snapshot.matching);
  return {
    client,
    subscribeCount: trace.subscribes.length,
    retryCount: Math.max(0, trace.subscribes.length - 1),
    snapshotCount: trace.snapshots.length,
    matchingSnapshotCount: matchingSnapshots.length,
    nonMatchingSnapshotCount: nonMatching.length,
    nonMatchingSnapshotBytes: nonMatching.reduce((sum, snapshot) => sum + snapshot.bytes, 0),
    totalMatchingSnapshotBytes: matchingSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.bytes,
      0,
    ),
    appliedSnapshotBytes: appliedSnapshot.bytes,
    snapshotOutputSeq: appliedSnapshot.outputSeq,
    watermarkOutputSeq: trace.watermarkSeq,
    replayedFrameCount: relevantSeqs.length,
    sequenceGapCount: gaps,
    sequenceDuplicateCount: duplicates,
    subscribeToSnapshotMs: round(appliedSnapshot.at - firstSubscribe.at),
    subscribeToReadyMs: round((trace.readyAt ?? appliedSnapshot.at) - firstSubscribe.at),
    subscribeToWatermarkReceiveMs: round(trace.watermarkReceivedAt - firstSubscribe.at),
    subscribeToWatermarkPaintMs: round(trace.paintedAt - firstSubscribe.at),
    readyToWatermarkPaintMs: round(trace.paintedAt - (trace.readyAt ?? appliedSnapshot.at)),
  };
}

function buildPartialClientMetric(trace: BrowserTrace, client: number): PartialClientMetric {
  const firstSubscribe = trace.subscribes[0];
  const matching = trace.snapshots.filter((snapshot) => snapshot.matching);
  const nonMatching = trace.snapshots.filter((snapshot) => !snapshot.matching);
  const latestMatching = matching.at(-1);
  const relative = (at: number | null): number | null =>
    firstSubscribe && at !== null ? round(at - firstSubscribe.at) : null;
  return {
    client,
    subscribeCount: trace.subscribes.length,
    retryCount: Math.max(0, trace.subscribes.length - 1),
    snapshotCount: trace.snapshots.length,
    matchingSnapshotCount: matching.length,
    nonMatchingSnapshotCount: nonMatching.length,
    totalMatchingSnapshotBytes: matching.reduce((sum, snapshot) => sum + snapshot.bytes, 0),
    nonMatchingSnapshotBytes: nonMatching.reduce((sum, snapshot) => sum + snapshot.bytes, 0),
    latestMatchingSnapshotOutputSeq: latestMatching?.outputSeq ?? null,
    watermarkOutputSeq: trace.watermarkSeq,
    readyObserved: trace.readyAt !== null,
    watermarkReceived: trace.watermarkReceivedAt !== null,
    watermarkPainted: trace.paintedAt !== null,
    subscribeToLatestSnapshotMs: relative(latestMatching?.at ?? null),
    subscribeToReadyMs: relative(trace.readyAt),
    subscribeToWatermarkReceiveMs: relative(trace.watermarkReceivedAt),
    subscribeToWatermarkPaintMs: relative(trace.paintedAt),
  };
}

function benchmarkOutputPath(clientCount: number): string {
  const configured = process.env.PTY_SYNC_BENCH_OUTPUT;
  if (configured) {
    return resolve(process.cwd(), configured.replaceAll("{clients}", String(clientCount)));
  }
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return resolve(REPO_ROOT, `artifacts/benchmarks/pty-sync/${stamp}-${clientCount}-clients.json`);
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
