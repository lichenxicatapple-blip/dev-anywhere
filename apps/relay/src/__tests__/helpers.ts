import { WebSocket } from "ws";
import type { MessageType, MessageSource } from "@cc-anywhere/shared";
import type { RelayServer } from "#src/server.js";

/**
 * 等待 WebSocket 连接打开
 */
export function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.on("open", resolve);
    ws.on("error", reject);
  });
}

/**
 * 等待收到一条指定类型的 WebSocket 消息，超时后 reject
 */
export function waitForMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForMessage timeout")), timeoutMs);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(data.toString());
    });
  });
}

/**
 * 等待收到指定 type 字段的消息，跳过不匹配的消息
 */
export function waitForMessageType(ws: WebSocket, type: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeListener("message", onMessage);
      reject(new Error(`waitForMessageType(${type}) timeout`));
    }, timeoutMs);
    function onMessage(data: { toString(): string }) {
      const raw = data.toString();
      try {
        const parsed = JSON.parse(raw) as { type?: string };
        if (parsed.type === type) {
          clearTimeout(timer);
          ws.removeListener("message", onMessage);
          resolve(raw);
        }
      } catch {
        // 非 JSON 消息，跳过
      }
    }
    ws.on("message", onMessage);
  });
}

/**
 * 收集指定数量的消息，超时后返回已收集的部分
 */
export function collectMessages(ws: WebSocket, count: number, timeoutMs = 2000): Promise<string[]> {
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

/**
 * 获取已监听服务器的端口
 */
export function getPort(server: RelayServer): number {
  const addr = server.httpServer.address();
  if (typeof addr === "object" && addr !== null) {
    return addr.port;
  }
  throw new Error("Server not listening");
}

/**
 * 等待指定毫秒数
 */
export const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

/**
 * 构造测试用 Envelope 对象
 */
export function makeEnvelope(
  seq: number,
  sessionId = "s1",
  type: MessageType = "assistant_message",
  source: MessageSource = "proxy",
) {
  const payloads: Record<string, unknown> = {
    assistant_message: { text: `msg-${seq}`, isPartial: false },
    user_input: { text: `input-${seq}` },
  };
  return {
    seq,
    sessionId,
    timestamp: Date.now(),
    source,
    version: "1.0",
    type,
    payload: payloads[type] ?? { text: `msg-${seq}`, isPartial: false },
  };
}
