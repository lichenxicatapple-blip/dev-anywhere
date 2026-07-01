import type { WebSocket, WebSocketServer } from "ws";
import type { Logger } from "@dev-anywhere/shared/logger";

interface HeartbeatSocket extends WebSocket {
  isAlive?: boolean;
}

interface HeartbeatOptions {
  logger?: Pick<Logger, "warn">;
  peerType?: string;
  describePeer?: (ws: WebSocket) => Record<string, unknown>;
}

function markAlive(ws: WebSocket): void {
  (ws as HeartbeatSocket).isAlive = true;
}

// 通用 WebSocket 心跳检测，检测死连接并 terminate
// terminate 触发 close 事件，后续由各自的 close handler 处理恢复逻辑
export function setupHeartbeat(
  wss: WebSocketServer,
  interval = 30000,
  options: HeartbeatOptions = {},
): NodeJS.Timeout {
  wss.on("connection", (ws) => {
    markAlive(ws);
    ws.on("pong", () => {
      markAlive(ws);
    });
  });

  return setInterval(() => {
    for (const ws of wss.clients) {
      const sock = ws as HeartbeatSocket;
      if (sock.isAlive === false) {
        options.logger?.warn(
          {
            peerType: options.peerType,
            ...(options.describePeer?.(ws) ?? {}),
          },
          "WebSocket heartbeat timeout",
        );
        sock.terminate();
        continue;
      }
      sock.isAlive = false;
      sock.ping();
    }
  }, interval);
}
