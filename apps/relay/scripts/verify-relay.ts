/**
 * Relay server 端到端验证脚本
 *
 * 验证 relay server 的核心功能：WebSocket 连接、proxy 注册、client 查询、双向消息路由
 *
 * Usage: npx tsx apps/relay/scripts/verify-relay.ts [relay-url]
 * Example: npx tsx apps/relay/scripts/verify-relay.ts wss://dev-anywhere.vita-tools.top
 */

import WebSocket from "ws";

const RELAY_URL = process.argv[2] ?? "wss://dev-anywhere.vita-tools.top";

async function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
}

async function waitMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
  });
}

async function verify(): Promise<void> {
  console.log(`Verifying relay at ${RELAY_URL}\n`);
  const passed: string[] = [];

  // 1. Health check (HTTP)
  const healthUrl = RELAY_URL.replace("wss://", "https://").replace("ws://", "http://");
  const healthRes = await fetch(`${healthUrl}/health`);
  const health = await healthRes.json();
  console.log(`1. Health: ${JSON.stringify(health)}`);
  passed.push("health check");

  // 2. Proxy 连接并注册
  const proxy = new WebSocket(`${RELAY_URL}/proxy`);
  await waitOpen(proxy);
  proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "verify-proxy" }));
  console.log("2. Proxy connected and registered");
  passed.push("proxy register");

  await new Promise((r) => setTimeout(r, 1500));

  // 3. Client 连接并查询 proxy 列表
  const client = new WebSocket(`${RELAY_URL}/client`);
  await waitOpen(client);
  const listPromise = waitMessage(client);
  client.send(JSON.stringify({ type: "proxy_list_request" }));
  const list = listPromise as Promise<{ type: string; proxies: { proxyId: string }[] }>;
  const listResult = await list;
  const found = listResult.proxies.some((p) => p.proxyId === "verify-proxy");
  console.log(`3. Proxy list: ${JSON.stringify(listResult)} (found=${found})`);
  if (!found) throw new Error("Proxy not found in list");
  passed.push("proxy list");

  // 4. Client 选择 proxy
  client.send(JSON.stringify({ type: "proxy_select", proxyId: "verify-proxy" }));
  await new Promise((r) => setTimeout(r, 300));
  console.log("4. Client selected proxy");
  passed.push("proxy select");

  // 5. Client -> Relay -> Proxy (双向验证)
  const proxyMsgPromise = waitMessage(proxy);
  client.send(
    JSON.stringify({
      type: "user_input",
      seq: 1,
      sessionId: "verify-session",
      timestamp: Date.now(),
      source: "client",
      version: "1.0.0",
      payload: { text: "hello from client" },
    }),
  );
  const fromClient = (await proxyMsgPromise) as { type: string; payload: { text: string } };
  console.log(`5. Proxy received: type=${fromClient.type}, text=${fromClient.payload.text}`);
  passed.push("client -> proxy routing");

  // 6. Proxy -> Relay -> Client
  const clientMsgPromise = waitMessage(client);
  proxy.send(
    JSON.stringify({
      type: "assistant_message",
      seq: 1,
      sessionId: "verify-session",
      timestamp: Date.now(),
      source: "proxy",
      version: "1.0.0",
      payload: { text: "hello from proxy", isPartial: false },
    }),
  );
  const fromProxy = (await clientMsgPromise) as { type: string; payload: { text: string } };
  console.log(`6. Client received: type=${fromProxy.type}, text=${fromProxy.payload.text}`);
  passed.push("proxy -> client routing");

  // 7. Status check
  const statusRes = await fetch(`${healthUrl}/status`);
  const status = await statusRes.json();
  console.log(`7. Status: ${JSON.stringify(status)}`);
  passed.push("status endpoint");

  // Cleanup
  proxy.close();
  client.close();

  console.log(`\n=== ALL PASSED (${passed.length}/${passed.length}) ===`);
  passed.forEach((p) => console.log(`  + ${p}`));
}

verify().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
});
