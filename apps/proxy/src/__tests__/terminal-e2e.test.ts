import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import pino from "pino";
import { createRelayServer, type RelayServer } from "../../../../apps/relay/src/server.js";
import { TerminalTracker } from "../terminal-tracker.js";
import { createTerminalPushHandler, FRAME_PUSH_INTERVAL_MS } from "../handlers/terminal-push.js";
import { createControlMessageHandlers } from "../handlers/control-messages.js";

const logger = pino({ level: "silent" });
const FIXTURES_DIR = join(import.meta.dirname, "fixtures");

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

function collectMessages(ws: WebSocket, count: number, timeoutMs = 5000): Promise<string[]> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    const timer = setTimeout(() => {
      ws.removeListener("message", onMessage);
      resolve(messages);
    }, timeoutMs);

    function onMessage(data: { toString(): string }) {
      messages.push(data.toString());
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.removeListener("message", onMessage);
        resolve(messages);
      }
    }
    ws.on("message", onMessage);
  });
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/**
 * 终端端到端集成测试
 *
 * 使用录制的真实 Claude Code PTY 输出，验证完整链路：
 * 录制数据 → TerminalTracker (xterm headless) → terminal-push handler → relay → test client
 *
 * 同时验证 terminal_lines_request/response 的 lineId 寻址链路：
 * test client → relay → proxy handler → TerminalTracker.extractLines → response → test client
 */
describe("Terminal E2E with real Claude output", () => {
  let relay: RelayServer;
  let port: number;
  const connections: WebSocket[] = [];

  // 录制的真实 Claude Code 终端输出
  let rawTerminalData: string;

  beforeEach(async () => {
    rawTerminalData = readFileSync(join(FIXTURES_DIR, "claude-session.raw"), "utf-8");

    relay = createRelayServer({ port: 0, heartbeatInterval: 60000, logger });
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

  it("real Claude output produces valid terminal_frame via relay", async () => {
    const { proxyWs, clientWs } = await setupBoundPair();

    // 在 proxy 侧构建 TerminalTracker 并喂入真实数据
    const tracker = new TerminalTracker(120, 40);
    await tracker.feed(rawTerminalData);

    // 提取网格，构造 Control 格式的 terminal_frame
    const grid = tracker.extractGrid();
    expect(grid.length).toBeGreaterThan(0);

    // 通过 proxy WebSocket 发送给 relay
    const clientMsgPromise = waitForMessage(clientWs);
    proxyWs.send(JSON.stringify({
      type: "terminal_frame",
      sessionId: "pty-1",
      payload: { mode: "full", lines: grid },
    }));

    // test client 应收到完整 terminal_frame
    const received = JSON.parse(await clientMsgPromise);
    expect(received.type).toBe("terminal_frame");
    expect(received.sessionId).toBe("pty-1");
    expect(received.payload.mode).toBe("full");
    expect(received.payload.lines.length).toBeGreaterThan(0);

    // 验证内容不是空的 — 真实 Claude 输出应包含可见文本
    const allText = received.payload.lines
      .flatMap((line: Array<{ text: string }>) => line.map((s) => s.text))
      .join("");
    expect(allText.trim().length).toBeGreaterThan(0);

    tracker.dispose();
  });

  it("terminal-push handler sends full then delta frames from real data", async () => {
    const sentMessages: string[] = [];
    const send = (data: string) => sentMessages.push(data);

    const pushHandler = createTerminalPushHandler(send, logger);
    const tracker = new TerminalTracker(120, 40);

    // 把录制数据分成两段喂入，模拟流式输出
    const midpoint = Math.floor(rawTerminalData.length / 2);
    const firstHalf = rawTerminalData.slice(0, midpoint);
    const secondHalf = rawTerminalData.slice(midpoint);

    await tracker.feed(firstHalf);
    pushHandler.start("pty-1", tracker);

    // 等待首帧推送（200ms 周期）
    await settle(FRAME_PUSH_INTERVAL_MS + 100);

    // 应有至少一条消息（首帧 full）
    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const firstFrame = JSON.parse(sentMessages[0]);
    expect(firstFrame.type).toBe("terminal_frame");
    expect(firstFrame.payload.mode).toBe("full");
    expect(firstFrame.payload.lines.length).toBeGreaterThan(0);

    // 喂入第二段数据
    await tracker.feed(secondHalf);

    // 等待 delta 帧
    await settle(FRAME_PUSH_INTERVAL_MS + 100);

    // 应有更多消息，且后续帧为 delta 模式
    expect(sentMessages.length).toBeGreaterThanOrEqual(2);
    const laterFrame = JSON.parse(sentMessages[sentMessages.length - 1]);
    expect(laterFrame.type).toBe("terminal_frame");
    expect(laterFrame.payload.mode).toBe("delta");
    expect(laterFrame.payload.lines.length).toBeGreaterThan(0);

    pushHandler.stopAll();
    tracker.dispose();
  });

  it("terminal_lines_request/response works with real data through relay", async () => {
    const { proxyWs, clientWs } = await setupBoundPair();

    // proxy 侧准备 TerminalTracker
    const tracker = new TerminalTracker(120, 40);
    await tracker.feed(rawTerminalData);

    const oldest = tracker.getOldestLineId();
    const newest = tracker.getNewestLineId();
    expect(newest).toBeGreaterThan(oldest);

    // proxy 监听来自 relay 的 terminal_lines_request
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

    // client 发送 terminal_lines_request
    const responsePromise = waitForMessage(clientWs);
    clientWs.send(JSON.stringify({
      type: "terminal_lines_request",
      sessionId: "pty-1",
      fromLineId: oldest,
      count: 20,
    }));

    const response = JSON.parse(await responsePromise);
    expect(response.type).toBe("terminal_lines_response");
    expect(response.sessionId).toBe("pty-1");
    expect(response.fromLineId).toBe(oldest);
    expect(response.oldestLineId).toBe(oldest);
    expect(response.newestLineId).toBe(newest);
    expect(response.lines.length).toBe(20);

    // 每行是 TermSpan 数组
    for (const line of response.lines) {
      expect(Array.isArray(line)).toBe(true);
      for (const span of line) {
        expect(typeof span.text).toBe("string");
      }
    }

    tracker.dispose();
  });

  it("bidirectional scrolling with real data: up, down, up again", async () => {
    const tracker = new TerminalTracker(120, 40);
    await tracker.feed(rawTerminalData);

    const oldest = tracker.getOldestLineId();
    const newest = tracker.getNewestLineId();
    const totalLines = newest - oldest + 1;

    // 模拟手机端双向滚动
    // 1. 向上翻：拉最早的 10 行
    const topLines = tracker.extractLines(oldest, 10);
    expect(topLines.length).toBe(Math.min(10, totalLines));

    // 2. 向下翻：拉中间 10 行
    const midId = oldest + Math.floor(totalLines / 2);
    const midLines = tracker.extractLines(midId, 10);
    expect(midLines.length).toBeGreaterThan(0);

    // 3. 再向上翻：同一范围应返回相同内容
    const topAgain = tracker.extractLines(oldest, 10);
    expect(topAgain.length).toBe(topLines.length);

    const text1 = topLines.flatMap((l) => l.map((s) => s.text)).join("");
    const text2 = topAgain.flatMap((l) => l.map((s) => s.text)).join("");
    expect(text2).toBe(text1);

    // 4. 拉最新的 viewport（模拟"回到底部"）
    const bottomLines = tracker.extractLines(newest - 9, 10);
    expect(bottomLines.length).toBeGreaterThan(0);

    tracker.dispose();
  });

  it("real data produces non-trivial content with colors and styles", async () => {
    const tracker = new TerminalTracker(120, 40);
    await tracker.feed(rawTerminalData);

    const grid = tracker.extractGrid();
    const allSpans = grid.flatMap((line) => line);

    // 真实 Claude Code 输出应包含有颜色的 span
    const coloredSpans = allSpans.filter((s) => s.fg || s.bg);
    expect(coloredSpans.length).toBeGreaterThan(0);

    // 应包含非空文本
    const textContent = allSpans.map((s) => s.text).join("");
    expect(textContent.trim().length).toBeGreaterThan(100);

    tracker.dispose();
  });

  it("handleTerminalLinesRequest integration with real tracker", () => {
    const sentMessages: string[] = [];
    const send = (data: string) => sentMessages.push(data);

    // 直接实例化 control message handler（不需要完整 SessionManager）
    const handlers = createControlMessageHandlers(
      send,
      { listSessions: () => [] } as any,
      logger,
    );

    const tracker = new TerminalTracker(120, 40);
    // 同步喂入一小段数据（feed 返回 Promise 但 xterm write 对短数据几乎同步）
    tracker.feed(rawTerminalData.slice(0, 10000)).then(() => {
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
      expect(response.oldestLineId).toBeDefined();
      expect(response.newestLineId).toBeDefined();

      tracker.dispose();
    });
  });
});
