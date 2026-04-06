import { WebSocketServer } from "ws";
import type { WebSocket as WsType } from "ws";

interface EchoServerResult {
  server: WsType.Server;
  close: () => void;
}

/**
 * 创建一个回显 WebSocket 服务，接收 JSON 文本帧并原样返回。
 * 如果收到的文本不是合法 JSON，返回 { error: "invalid JSON" }。
 * 仅用于本地开发测试，不部署到生产环境。
 */
export function startEchoServer(port: number): EchoServerResult {
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      const text = data.toString();
      try {
        JSON.parse(text);
        ws.send(text);
      } catch {
        ws.send(JSON.stringify({ error: "invalid JSON" }));
      }
    });
  });

  const close = () => {
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
  };

  return { server: wss, close };
}

const isMain =
  process.argv[1]?.endsWith("echo-server.ts") ||
  process.argv[1]?.endsWith("echo-server.js");

if (isMain) {
  startEchoServer(9099);
  console.log("Echo server listening on ws://localhost:9099");
}
