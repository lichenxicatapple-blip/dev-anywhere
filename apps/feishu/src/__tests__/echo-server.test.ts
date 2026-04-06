import { describe, test, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startEchoServer } from "../echo-server.js";

// 测试用端口，每个测试使用独立端口避免冲突
let nextPort = 19100;
function getPort() {
  return nextPort++;
}

// 辅助函数：创建 WebSocket 客户端并等待连接建立
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

// 辅助函数：等待接收一条消息
function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(data.toString()));
  });
}

describe("echo-server", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) {
      cleanup();
    }
    cleanups.length = 0;
  });

  test("starts server and accepts WebSocket connections", async () => {
    const port = getPort();
    const { close } = startEchoServer(port);
    cleanups.push(close);

    const ws = await connectClient(port);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  test("echoes valid JSON back to the client", async () => {
    const port = getPort();
    const { close } = startEchoServer(port);
    cleanups.push(close);

    const ws = await connectClient(port);
    const message = { text: "hello", ts: 1234567890 };

    const responsePromise = waitForMessage(ws);
    ws.send(JSON.stringify(message));
    const response = await responsePromise;

    expect(JSON.parse(response)).toEqual(message);
    ws.close();
  });

  test("returns error for invalid JSON", async () => {
    const port = getPort();
    const { close } = startEchoServer(port);
    cleanups.push(close);

    const ws = await connectClient(port);

    const responsePromise = waitForMessage(ws);
    ws.send("not valid json {{{");
    const response = await responsePromise;

    expect(JSON.parse(response)).toEqual({ error: "invalid JSON" });
    ws.close();
  });

  test("handles multiple concurrent connections independently", async () => {
    const port = getPort();
    const { close } = startEchoServer(port);
    cleanups.push(close);

    const ws1 = await connectClient(port);
    const ws2 = await connectClient(port);

    const msg1 = { client: 1, data: "first" };
    const msg2 = { client: 2, data: "second" };

    const response1Promise = waitForMessage(ws1);
    const response2Promise = waitForMessage(ws2);

    ws1.send(JSON.stringify(msg1));
    ws2.send(JSON.stringify(msg2));

    const [response1, response2] = await Promise.all([
      response1Promise,
      response2Promise,
    ]);

    expect(JSON.parse(response1)).toEqual(msg1);
    expect(JSON.parse(response2)).toEqual(msg2);

    ws1.close();
    ws2.close();
  });

  test("closes cleanly without errors", async () => {
    const port = getPort();
    const { close } = startEchoServer(port);

    const ws = await connectClient(port);
    ws.close();

    // close 应该正常关闭，不抛异常
    close();

    // 关闭后不能再连接
    await expect(
      new Promise<void>((resolve, reject) => {
        const client = new WebSocket(`ws://localhost:${port}`);
        client.on("open", () => {
          client.close();
          reject(new Error("Should not connect after close"));
        });
        client.on("error", () => resolve());
      }),
    ).resolves.toBeUndefined();
  });
});
