import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import pino from "pino";
import { createRelayServer, type RelayServer } from "@cc-anywhere/relay/server";
import { TerminalTracker, type TermLine, type TermSpan } from "#src/terminal-tracker.js";
import { createControlMessageHandlers } from "#src/handlers/control-messages.js";
import {
  TerminalFrameRenderer,
} from "#src/terminal-frame-renderer.js";

const relayLogger = pino({ level: "silent" });
const FIXTURES_DIR = join(import.meta.dirname, "../fixtures");

/**
 * 从 NDJSON fixture 文件加载录制的 PTY chunk
 * 数据行格式：{"ts":<ms>, "data":"<escaped string>"}
 * resize 行格式：{"ts":<ms>, "resize":{"cols":<n>, "rows":<n>}}
 * 只返回 data 行，过滤掉 resize 行
 */
function loadRecordedChunks(): Array<{ ts: number; data: string }> {
  const content = readFileSync(join(FIXTURES_DIR, "claude-chunks.ndjson"), "utf-8");
  return content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record: { data?: string }) => record.data !== undefined);
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) { resolve(); return; }
    ws.on("open", resolve);
    ws.on("error", reject);
  });
}

function waitForMessage(ws: WebSocket, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForMessage timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/**
 * 终端端到端集成测试
 *
 * 使用 `cc-anywhere serve record` 录制的真实 PTY chunk（NDJSON 格式）
 * 按原始分片逐 chunk 喂入 TerminalTracker，精确还原 PtyManager.onData 的行为。
 */
describe("Terminal E2E with recorded PTY chunks", () => {
  let relay: RelayServer;
  let port: number;
  const connections: WebSocket[] = [];
  let chunks: Array<{ ts: number; data: string }>;

  beforeEach(async () => {
    chunks = loadRecordedChunks();

    relay = createRelayServer({ port: 0, heartbeatInterval: 60000, logger: relayLogger });
    await new Promise<void>((resolve) => {
      relay.httpServer.listen(0, resolve);
    });
    const addr = relay.httpServer.address();
    port = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterEach(async () => {
    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }
    connections.length = 0;
    await relay.close();
  });

  function connectProxy(): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/proxy`);
    connections.push(ws);
    return ws;
  }

  function connectClient(): WebSocket {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/client`);
    connections.push(ws);
    return ws;
  }

  async function setupBoundPair(): Promise<{ proxyWs: WebSocket; clientWs: WebSocket }> {
    const proxyWs = connectProxy();
    await waitForOpen(proxyWs);
    proxyWs.send(JSON.stringify({ type: "proxy_register", proxyId: "e2e-proxy" }));
    await settle();
    const clientWs = connectClient();
    await waitForOpen(clientWs);
    clientWs.send(JSON.stringify({ type: "client_register", clientId: "e2e-client" }));
    await settle();
    clientWs.send(JSON.stringify({ type: "proxy_select", proxyId: "e2e-proxy" }));
    await settle();
    return { proxyWs, clientWs };
  }

  // 喂入前 N 个 chunk 到 tracker
  async function feedChunks(tracker: TerminalTracker, count: number): Promise<void> {
    const n = Math.min(count, chunks.length);
    for (let i = 0; i < n; i++) {
      await tracker.feed(chunks[i].data);
    }
  }

  it("fixture has real PTY chunks with varying sizes", () => {
    expect(chunks.length).toBeGreaterThan(100);

    const sizes = chunks.map((c) => c.data.length);
    const minSize = Math.min(...sizes);
    const maxSize = Math.max(...sizes);

    // 真实 PTY chunk 大小不固定
    expect(maxSize).toBeGreaterThan(minSize * 10);

    // 时间戳单调递增
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].ts).toBeGreaterThanOrEqual(chunks[i - 1].ts);
    }
  });

  it("each chunk feed produces a valid extractable grid", async () => {
    const tracker = new TerminalTracker(120, 40);

    // 逐 chunk 喂入前 50 个，每次检查 extractGrid
    const n = Math.min(50, chunks.length);
    for (let i = 0; i < n; i++) {
      await tracker.feed(chunks[i].data);
      const grid = tracker.extractGrid();
      expect(Array.isArray(grid)).toBe(true);
    }

    const finalGrid = tracker.extractGrid();
    const allText = finalGrid.flatMap((l) => l.map((s) => s.text)).join("");
    expect(allText.trim().length).toBeGreaterThan(0);

    tracker.dispose();
  });

  it("lineId grows monotonically as chunks arrive", async () => {
    const tracker = new TerminalTracker(120, 40);
    const lineIdHistory: number[] = [];

    const n = Math.min(100, chunks.length);
    for (let i = 0; i < n; i++) {
      await tracker.feed(chunks[i].data);
      lineIdHistory.push(tracker.getNewestLineId());
    }

    // 单调递增或保持不变
    for (let i = 1; i < lineIdHistory.length; i++) {
      expect(lineIdHistory[i]).toBeGreaterThanOrEqual(lineIdHistory[i - 1]);
    }
    // 整体有增长
    expect(lineIdHistory[lineIdHistory.length - 1]).toBeGreaterThan(lineIdHistory[0]);

    tracker.dispose();
  });

  it("TerminalFrameRenderer: applyFrame full sets viewport", async () => {
    const tracker = new TerminalTracker(120, 40);
    await feedChunks(tracker, 20);
    const grid = tracker.extractGrid();

    const renderer = new TerminalFrameRenderer();
    renderer.applyFrame({
      type: "terminal_frame",
      sessionId: "pty-1",
      payload: { mode: "full", lines: grid },
    });

    const viewport = renderer.getViewportLines();
    expect(viewport.length).toBe(grid.length);
    expect(viewport[0]).toEqual(grid[0]);

    tracker.dispose();
  });

  it("TerminalFrameRenderer: applyFrame delta only updates specified lines", async () => {
    const tracker = new TerminalTracker(120, 40);
    await feedChunks(tracker, 20);
    const grid = tracker.extractGrid();

    const renderer = new TerminalFrameRenderer();
    // 先设置 full 帧
    renderer.applyFrame({
      type: "terminal_frame",
      sessionId: "pty-1",
      payload: { mode: "full", lines: grid },
    });

    const originalLine0 = [...renderer.getViewportLines()[0]];
    const newSpans: TermSpan[] = [{ text: "REPLACED LINE", fg: "#ff0000" }];

    // delta 帧只更新第 2 行
    renderer.applyFrame({
      type: "terminal_frame",
      sessionId: "pty-1",
      payload: { mode: "delta", lines: [{ lineIndex: 1, spans: newSpans }] },
    });

    // 第 0 行不变
    expect(renderer.getViewportLines()[0]).toEqual(originalLine0);
    // 第 1 行已更新
    expect(renderer.getViewportLines()[1][0].text).toBe("REPLACED LINE");
  });

  it("TerminalFrameRenderer: applyLinesResponse fills scrollback cache", () => {
    const renderer = new TerminalFrameRenderer();
    const lines: TermLine[] = [
      [{ text: "line 100" }],
      [{ text: "line 101" }],
      [{ text: "line 102" }],
    ];

    renderer.applyLinesResponse({
      type: "terminal_lines_response",
      sessionId: "pty-1",
      fromLineId: 100,
      oldestLineId: 50,
      newestLineId: 200,
      lines,
    });

    expect(renderer.cacheSize).toBe(3);
    expect(renderer.oldestLineId).toBe(50);
    expect(renderer.newestLineId).toBe(200);

    const cached = renderer.getCachedLines(100, 3);
    expect(cached[0]![0].text).toBe("line 100");
    expect(cached[2]![0].text).toBe("line 102");
  });

  it("TerminalFrameRenderer: getMissingRange detects cache holes", () => {
    const renderer = new TerminalFrameRenderer();

    // 填充 100-102
    renderer.applyLinesResponse({
      type: "terminal_lines_response",
      sessionId: "pty-1",
      fromLineId: 100,
      oldestLineId: 50,
      newestLineId: 200,
      lines: [[{ text: "a" }], [{ text: "b" }], [{ text: "c" }]],
    });

    // 查询 98-105 范围，98-99 和 103-105 未缓存
    const missing = renderer.getMissingRange(98, 8);
    expect(missing).not.toBeNull();
    expect(missing!.fromLineId).toBe(98);

    // 全部命中时返回 null
    const noMissing = renderer.getMissingRange(100, 3);
    expect(noMissing).toBeNull();
  });

  it("TerminalFrameRenderer: clearCache resets scrollback", () => {
    const renderer = new TerminalFrameRenderer();
    renderer.applyLinesResponse({
      type: "terminal_lines_response",
      sessionId: "pty-1",
      fromLineId: 0,
      oldestLineId: 0,
      newestLineId: 10,
      lines: [[{ text: "x" }]],
    });
    expect(renderer.cacheSize).toBe(1);

    renderer.clearCache();
    expect(renderer.cacheSize).toBe(0);
  });

  it("extractLines at mid-stream: content stable after more chunks arrive", async () => {
    const tracker = new TerminalTracker(120, 40);

    // 喂入一半 chunk
    const halfIdx = Math.floor(chunks.length / 2);
    await feedChunks(tracker, halfIdx);

    const oldest = tracker.getOldestLineId();
    const lines = tracker.extractLines(oldest, 10);
    const textBefore = lines.map((l) => l.map((s) => s.text).join("")).join("\n");

    // 喂入剩余 chunk
    for (let i = halfIdx; i < chunks.length; i++) {
      await tracker.feed(chunks[i].data);
    }

    // 如果 scrollback 没溢出，同一 lineId 范围的内容不变
    const newOldest = tracker.getOldestLineId();
    if (newOldest <= oldest) {
      const linesAfter = tracker.extractLines(oldest, 10);
      const textAfter = linesAfter.map((l) => l.map((s) => s.text).join("")).join("\n");
      expect(textAfter).toBe(textBefore);
    }

    tracker.dispose();
  });

  it("relay e2e: client receives terminal_frame from chunked data", async () => {
    const { proxyWs, clientWs } = await setupBoundPair();
    const tracker = new TerminalTracker(120, 40);

    await feedChunks(tracker, 30);
    const grid = tracker.extractGrid();

    const clientMsgPromise = waitForMessage(clientWs);
    proxyWs.send(JSON.stringify({
      type: "terminal_frame",
      sessionId: "pty-1",
      payload: { mode: "full", lines: grid },
    }));

    const received = JSON.parse(await clientMsgPromise);
    expect(received.type).toBe("terminal_frame");
    expect(received.payload.lines.length).toBe(grid.length);

    tracker.dispose();
  });

  it("relay e2e: terminal_lines_request/response roundtrip", async () => {
    const { proxyWs, clientWs } = await setupBoundPair();
    const tracker = new TerminalTracker(120, 40);

    await feedChunks(tracker, 50);

    proxyWs.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "terminal_lines_request") {
        const lines = tracker.extractLines(msg.fromLineId, msg.count);
        proxyWs.send(JSON.stringify({
          type: "terminal_lines_response",
          sessionId: msg.sessionId,
          fromLineId: msg.fromLineId,
          oldestLineId: tracker.getOldestLineId(),
          newestLineId: tracker.getNewestLineId(),
          lines,
        }));
      }
    });

    const oldest = tracker.getOldestLineId();
    const responsePromise = waitForMessage(clientWs);
    clientWs.send(JSON.stringify({
      type: "terminal_lines_request",
      sessionId: "pty-1",
      fromLineId: oldest,
      count: 10,
    }));

    const response = JSON.parse(await responsePromise);
    expect(response.type).toBe("terminal_lines_response");
    expect(response.lines.length).toBe(10);
    expect(response.oldestLineId).toBe(oldest);

    tracker.dispose();
  });

  it("colored spans survive full chain with real data", async () => {
    const tracker = new TerminalTracker(120, 40);
    // Claude Code 前几个 chunk 包含带颜色的 logo
    await feedChunks(tracker, 10);

    const oldest = tracker.getOldestLineId();
    const lines = tracker.extractLines(oldest, 10);
    const allSpans = lines.flatMap((l) => l);
    const coloredSpans = allSpans.filter((s) => s.fg);

    // Claude Code logo 区域应有颜色
    expect(coloredSpans.length).toBeGreaterThan(0);

    tracker.dispose();
  });

  it("handleTerminalLinesRequest handler with real chunks", async () => {
    const sentMessages: string[] = [];
    const handlers = createControlMessageHandlers(
      (d) => sentMessages.push(d),
      { listSessions: () => [] } as unknown as Parameters<typeof createControlMessageHandlers>[1],
    );

    const tracker = new TerminalTracker(120, 40);
    await feedChunks(tracker, 30);

    handlers.registerTracker("pty-1", tracker);
    handlers.handleTerminalLinesRequest({
      sessionId: "pty-1",
      fromLineId: tracker.getOldestLineId(),
      count: 5,
    });

    expect(sentMessages.length).toBe(1);
    const response = JSON.parse(sentMessages[0]);
    expect(response.type).toBe("terminal_lines_response");
    expect(response.lines.length).toBeGreaterThan(0);
    expect(response.newestLineId).toBeGreaterThanOrEqual(response.oldestLineId);

    tracker.dispose();
  });

  it("extractLines covers full buffer range from oldest to newest", async () => {
    const tracker = new TerminalTracker(120, 40);

    for (const chunk of chunks) {
      await tracker.feed(chunk.data);
    }

    const oldest = tracker.getOldestLineId();
    const newest = tracker.getNewestLineId();
    const totalLines = newest - oldest + 1;

    // 能拉取全部范围
    const allLines = tracker.extractLines(oldest, totalLines);
    expect(allLines.length).toBe(totalLines);

    // 最后一行应有内容（不全是空的）
    // viewport 底部可能是空行，往上找一个非空行
    const lastNonEmptyIdx = [...allLines].reverse().findIndex(
      (line: Array<{ text: string }>) => line.map((s) => s.text).join("").trim().length > 0,
    );
    const actualIdx = lastNonEmptyIdx >= 0 ? allLines.length - 1 - lastNonEmptyIdx : -1;
    expect(actualIdx).toBeGreaterThan(0);

    tracker.dispose();
  });
});
