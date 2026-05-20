import type { WebSocket, WebSocketServer } from "ws";

interface HeartbeatSocket extends WebSocket {
  isAlive?: boolean;
}

function markAlive(ws: WebSocket): void {
  (ws as HeartbeatSocket).isAlive = true;
}

// 通用 WebSocket 心跳检测，检测死连接并 terminate
// terminate 触发 close 事件，后续由各自的 close handler 处理恢复逻辑
export function setupHeartbeat(wss: WebSocketServer, interval = 30000): NodeJS.Timeout {
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
        sock.terminate();
        continue;
      }
      sock.isAlive = false;
      sock.ping();
    }
  }, interval);
}
