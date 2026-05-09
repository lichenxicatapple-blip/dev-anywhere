/**
 * End-to-end relay verification script.
 *
 * Usage:
 *   pnpm --filter @dev-anywhere/relay exec tsx scripts/verify-relay.ts [relay-url]
 *
 * Authenticated relay:
 *   RELAY_PROXY_TOKEN=... RELAY_CLIENT_TOKEN=... \
 *     pnpm --filter @dev-anywhere/relay exec tsx scripts/verify-relay.ts wss://dev-anywhere.example.com
 */

import WebSocket from "ws";

const RELAY_URL = process.argv[2] ?? "ws://localhost:3100";
const RELAY_PROXY_TOKEN = process.env.RELAY_PROXY_TOKEN;
const RELAY_CLIENT_TOKEN = process.env.RELAY_CLIENT_TOKEN;

function normalizeRelayUrl(rawUrl: string): string {
  return rawUrl.replace(/\/(?:proxy|client)(?:\?.*)?$/, "").replace(/\/$/, "");
}

function withToken(baseUrl: string, path: "/proxy" | "/client", token: string | undefined): string {
  const url = new URL(`${baseUrl}${path}`);
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

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
  const relayBaseUrl = normalizeRelayUrl(RELAY_URL);
  console.log(`Verifying relay at ${relayBaseUrl}\n`);
  const passed: string[] = [];
  let proxy: WebSocket | null = null;
  let client: WebSocket | null = null;

  try {
    // 1. Health check (HTTP)
    const healthUrl = relayBaseUrl.replace("wss://", "https://").replace("ws://", "http://");
    const healthRes = await fetch(`${healthUrl}/health`);
    const health = await healthRes.json();
    console.log(`1. Health: ${JSON.stringify(health)}`);
    passed.push("health check");

    // 2. Connect and register a proxy.
    proxy = new WebSocket(withToken(relayBaseUrl, "/proxy", RELAY_PROXY_TOKEN));
    await waitOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "verify-proxy" }));
    console.log("2. Proxy connected and registered");
    passed.push("proxy register");

    await new Promise((r) => setTimeout(r, 1500));

    // 3. Connect a client and request the proxy list.
    client = new WebSocket(withToken(relayBaseUrl, "/client", RELAY_CLIENT_TOKEN));
    await waitOpen(client);
    const listPromise = waitMessage(client);
    client.send(JSON.stringify({ type: "proxy_list_request" }));
    const list = listPromise as Promise<{ type: string; proxies: { proxyId: string }[] }>;
    const listResult = await list;
    const found = listResult.proxies.some((p) => p.proxyId === "verify-proxy");
    console.log(`3. Proxy list: ${JSON.stringify(listResult)} (found=${found})`);
    if (!found) throw new Error("Proxy not found in list");
    passed.push("proxy list");

    // 4. Select the registered proxy.
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "verify-proxy" }));
    await new Promise((r) => setTimeout(r, 300));
    console.log("4. Client selected proxy");
    passed.push("proxy select");

    // 5. Client -> relay -> proxy.
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

    // 6. Proxy -> relay -> client.
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
  } finally {
    if (proxy?.readyState === WebSocket.OPEN) {
      proxy.send(JSON.stringify({ type: "proxy_disconnect", proxyId: "verify-proxy" }));
      await new Promise((r) => setTimeout(r, 100));
    }
    proxy?.close();
    client?.close();
  }

  console.log(`\n=== ALL PASSED (${passed.length}/${passed.length}) ===`);
  passed.forEach((p) => console.log(`  + ${p}`));
}

verify().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
});
