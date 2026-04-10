/**
 * Phase 5: Relay Resilience 验收测试（进程级 E2E）
 *
 * 本文件是 05-ACCEPTANCE.md 的可执行版本。
 * 每个测试 spawn 真实 relay 子进程，通过真实 TCP WebSocket 连接测试，
 * 用 SIGKILL/SIGTERM 模拟进程崩溃和优雅关闭。
 *
 * 跳过的章节：
 * - 第四节（Proxy 出站消息队列）：proxy 侧行为，由 relay-connection.test.ts 覆盖
 * - 第九~十一节（速查表）：文档性质，不可测试化
 * - 1.2（Proxy 自动重连退避）：proxy 侧 RelayConnection 行为
 * - 1.5（EventStore 对账回放）：proxy 侧 serve.ts 行为
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";
import { WebSocket } from "ws";
import { waitForOpen, waitForMessage, waitForMessageType, collectMessages, settle, makeEnvelope } from "../helpers.js";

const E2E_TIMEOUT = 30_000;
const RELAY_ENTRY = pathResolve(import.meta.dirname, "../..", "index.ts");

// ── 工具函数 ─────────────────────────────────────────────

async function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

interface SpawnRelayOptions {
  port: number;
  dataDir?: string;
  heartbeatInterval?: number;
}

function spawnRelay(opts: SpawnRelayOptions): ChildProcess {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PORT: String(opts.port),
    LOG_LEVEL: "silent",
  };
  // 显式设置 DATA_DIR：传了 dataDir 用指定路径，没传则禁用持久化防止加载残留数据
  env.DATA_DIR = opts.dataDir || "";
  if (opts.heartbeatInterval) env.HEARTBEAT_INTERVAL = String(opts.heartbeatInterval);
  // detached: true 创建新进程组，方便 killRelay 一次杀掉整个进程树
  const proc = spawn("npx", ["tsx", RELAY_ENTRY], { env, stdio: "pipe", detached: true });
  proc.unref();
  return proc;
}

// 杀掉整个进程组（npx → tsx → node）
function killRelay(proc: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (proc.pid && proc.exitCode === null) {
    try { process.kill(-proc.pid, signal); } catch { /* already dead */ }
  }
}

async function waitForReady(port: number, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch { /* 连接失败，继续重试 */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Relay not ready on port ${port} after ${timeoutMs}ms`);
}

function waitForExit(proc: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) {
      resolve(proc.exitCode);
      return;
    }
    const timer = setTimeout(() => {
      killRelay(proc);
      resolve(null);
    }, timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
    ws.on("close", () => resolve());
  });
}

async function fetchJson(port: number, path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return res.json() as Promise<Record<string, unknown>>;
}

// 每个 describe 块内的 WebSocket 自动清理
function createSocketTracker() {
  const sockets: WebSocket[] = [];
  return {
    track(ws: WebSocket): WebSocket { sockets.push(ws); return ws; },
    proxy(port: number): WebSocket {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/proxy`);
      sockets.push(ws);
      return ws;
    },
    client(port: number): WebSocket {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/client`);
      sockets.push(ws);
      return ws;
    },
    async cleanup() {
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      }
      sockets.length = 0;
      await settle(50);
    },
  };
}

// ── 一~五: 协议验证 ─────────────────────────────────────
// 共享一个 relay 进程，每个测试用唯一 ID 隔离状态

describe("proxy lifecycle", () => {
  let relay: ChildProcess;
  let port: number;
  const ws = createSocketTracker();
  let n = 0;
  const uid = () => `p1-${++n}`;

  beforeAll(async () => {
    port = await findFreePort();
    relay = spawnRelay({ port });
    await waitForReady(port);
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await ws.cleanup();
    killRelay(relay, "SIGTERM");
    await waitForExit(relay);
  });

  afterEach(async () => { await ws.cleanup(); });

  it("Proxy 正常注册 → proxy_register_response(new) + /status proxyCount", async () => {
    const id = uid();
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);

    const msgPromise = waitForMessage(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: id }));
    const response = JSON.parse(await msgPromise);

    expect(response.type).toBe("proxy_register_response");
    expect(response.status).toBe("new");
    expect(response.sessions).toBeUndefined();

    const status = await fetchJson(port, "/status") as { proxyCount: number };
    expect(status.proxyCount).toBeGreaterThanOrEqual(1);
  }, E2E_TIMEOUT);

  it("Proxy 异常断线 → proxy_offline 广播 + 状态保留", async () => {
    const id = uid();
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: id }));
    await waitForMessage(proxy);
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: id }));
    await settle();

    // proxy 异常断线
    const offlinePromise = waitForMessage(client);
    proxy.terminate();
    const offlineMsg = JSON.parse(await offlinePromise);

    expect(offlineMsg.type).toBe("proxy_offline");
    expect(offlineMsg.proxyId).toBe(id);

    // 状态保留：/status proxyCount 不减少
    const status = await fetchJson(port, "/status") as { proxyCount: number };
    expect(status.proxyCount).toBeGreaterThanOrEqual(1);
  }, E2E_TIMEOUT);

  it("Proxy 重连恢复 → reconnected + sessions seq map + proxy_online", async () => {
    const id = uid();

    // 第一次连接，发送消息填充 buffer
    const proxy1 = ws.proxy(port);
    await waitForOpen(proxy1);
    proxy1.send(JSON.stringify({ type: "proxy_register", proxyId: id }));
    await waitForMessage(proxy1);
    await settle();

    proxy1.send(JSON.stringify(makeEnvelope(1, "s-a")));
    proxy1.send(JSON.stringify(makeEnvelope(5, "s-a")));
    proxy1.send(JSON.stringify(makeEnvelope(3, "s-b")));
    await settle();

    // client 绑定
    const client = ws.client(port);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: id }));
    await collectMessages(client, 3, 1000);

    // proxy 断线
    const offlinePromise = waitForMessage(client);
    proxy1.terminate();
    await offlinePromise;
    await settle();

    // proxy 重连
    const onlinePromise = waitForMessage(client);
    const proxy2 = ws.proxy(port);
    await waitForOpen(proxy2);

    const registerPromise = waitForMessage(proxy2);
    proxy2.send(JSON.stringify({ type: "proxy_register", proxyId: id }));

    const response = JSON.parse(await registerPromise);
    expect(response.type).toBe("proxy_register_response");
    expect(response.status).toBe("reconnected");
    expect(response.sessions["s-a"]).toBe(5);
    expect(response.sessions["s-b"]).toBe(3);

    const onlineMsg = JSON.parse(await onlinePromise);
    expect(onlineMsg.type).toBe("proxy_online");
    expect(onlineMsg.proxyId).toBe(id);
  }, E2E_TIMEOUT);

  it("Proxy 主动退出 → proxy_offline + 资源清理 + proxyCount 减少", async () => {
    const id = uid();
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: id }));
    await waitForMessage(proxy);
    await settle();

    proxy.send(JSON.stringify(makeEnvelope(1, "s-cleanup")));
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: id }));
    await collectMessages(client, 1, 1000);

    const beforeStatus = await fetchJson(port, "/status") as { proxyCount: number };

    // 主动退出
    const offlinePromise = waitForMessage(client);
    proxy.send(JSON.stringify({ type: "proxy_disconnect", proxyId: id }));
    const offlineMsg = JSON.parse(await offlinePromise);

    expect(offlineMsg.type).toBe("proxy_offline");
    expect(offlineMsg.proxyId).toBe(id);

    await settle();

    const afterStatus = await fetchJson(port, "/status") as { proxyCount: number };
    expect(afterStatus.proxyCount).toBe(beforeStatus.proxyCount - 1);
  }, E2E_TIMEOUT);

  it("Proxy 未注册就发 envelope → NOT_REGISTERED", async () => {
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);

    const msgP = waitForMessage(proxy);
    proxy.send(JSON.stringify(makeEnvelope(1)));
    const resp = JSON.parse(await msgP);

    expect(resp.type).toBe("relay_error");
    expect(resp.code).toBe("NOT_REGISTERED");
  }, E2E_TIMEOUT);

  it("Proxy 重连 → 旧连接被 terminate", async () => {
    const id = uid();
    const proxy1 = ws.proxy(port);
    await waitForOpen(proxy1);
    proxy1.send(JSON.stringify({ type: "proxy_register", proxyId: id }));
    await waitForMessage(proxy1);

    // 第二个连接用同一 proxyId 注册
    const proxy2 = ws.proxy(port);
    await waitForOpen(proxy2);

    const closeP = new Promise<void>((resolve) => {
      proxy1.on("close", () => resolve());
    });

    proxy2.send(JSON.stringify({ type: "proxy_register", proxyId: id }));
    await waitForMessage(proxy2); // reconnected response

    // 旧连接应被 terminate
    await closeP;
    expect(proxy1.readyState).not.toBe(WebSocket.OPEN);
  }, E2E_TIMEOUT);

  it("多个 client 绑定同一 proxy，proxy 断线 → 所有 client 收到 proxy_offline", async () => {
    const id = uid();
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: id }));
    await waitForMessage(proxy);
    await settle();

    const client1 = ws.client(port);
    const client2 = ws.client(port);
    await waitForOpen(client1);
    await waitForOpen(client2);
    client1.send(JSON.stringify({ type: "proxy_select", proxyId: id }));
    client2.send(JSON.stringify({ type: "proxy_select", proxyId: id }));
    await settle();

    const offline1 = waitForMessage(client1);
    const offline2 = waitForMessage(client2);
    proxy.terminate();

    const msg1 = JSON.parse(await offline1);
    const msg2 = JSON.parse(await offline2);
    expect(msg1.type).toBe("proxy_offline");
    expect(msg2.type).toBe("proxy_offline");
  }, E2E_TIMEOUT);

  it("Proxy 多次断连重连循环 → 状态始终一致", async () => {
    const id = uid();

    for (let round = 1; round <= 3; round++) {
      const proxy = ws.proxy(port);
      await waitForOpen(proxy);
      const msgP = waitForMessage(proxy);
      proxy.send(JSON.stringify({ type: "proxy_register", proxyId: id }));
      const resp = JSON.parse(await msgP);

      if (round === 1) {
        expect(resp.status).toBe("new");
      } else {
        expect(resp.status).toBe("reconnected");
      }

      proxy.send(JSON.stringify(makeEnvelope(round, `cycle-${id}`)));
      await settle();

      proxy.close();
      await settle(200);
    }

    // 第 4 次重连，应拿到 sessions 最新 seq
    const proxy4 = ws.proxy(port);
    await waitForOpen(proxy4);
    const msgP = waitForMessage(proxy4);
    proxy4.send(JSON.stringify({ type: "proxy_register", proxyId: id }));
    const resp = JSON.parse(await msgP);
    expect(resp.status).toBe("reconnected");
    expect(resp.sessions[`cycle-${id}`]).toBe(3);
  }, E2E_TIMEOUT);
});

describe("client lifecycle", () => {
  let relay: ChildProcess;
  let port: number;
  const ws = createSocketTracker();
  let n = 0;
  const uid = (prefix = "p2") => `${prefix}-${++n}`;

  beforeAll(async () => {
    port = await findFreePort();
    relay = spawnRelay({ port });
    await waitForReady(port);
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await ws.cleanup();
    killRelay(relay, "SIGTERM");
    await waitForExit(relay);
  });

  afterEach(async () => { await ws.cleanup(); });

  it("Client 首次连接 + proxy_select → 消息双向路由", async () => {
    const proxyId = uid();
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);

    // proxy_list
    const listPromise = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_list_request" }));
    const listResp = JSON.parse(await listPromise);
    expect(listResp.type).toBe("proxy_list_response");
    expect(listResp.proxies.some((p: { proxyId: string }) => p.proxyId === proxyId)).toBe(true);

    // proxy_select + 双向
    client.send(JSON.stringify({ type: "proxy_select", proxyId }));
    await settle();

    const clientMsgP = waitForMessage(client);
    proxy.send(JSON.stringify(makeEnvelope(1)));
    expect(JSON.parse(await clientMsgP).type).toBe("assistant_message");

    const proxyMsgP = waitForMessage(proxy);
    client.send(JSON.stringify(makeEnvelope(2, "s1", "user_input", "client")));
    expect(JSON.parse(await proxyMsgP).type).toBe("user_input");
  }, E2E_TIMEOUT);

  it("proxy_select 不存在的 proxy → PROXY_NOT_FOUND", async () => {
    const client = ws.client(port);
    await waitForOpen(client);

    const msgP = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "ghost" }));
    const resp = JSON.parse(await msgP);

    expect(resp.type).toBe("relay_error");
    expect(resp.code).toBe("PROXY_NOT_FOUND");
  }, E2E_TIMEOUT);

  it("proxy_select 离线 proxy → PROXY_NOT_FOUND", async () => {
    const proxyId = uid();
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    proxy.close();
    await settle(200);

    const client = ws.client(port);
    await waitForOpen(client);

    const msgP = waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId }));
    const resp = JSON.parse(await msgP);

    expect(resp.type).toBe("relay_error");
    expect(resp.code).toBe("PROXY_NOT_FOUND");
  }, E2E_TIMEOUT);

  it("Client 断线重连（proxy 在线）→ restored + 增量回放", async () => {
    const proxyId = uid();
    const clientId = uid("c");

    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    const client1 = ws.client(port);
    await waitForOpen(client1);
    client1.send(JSON.stringify({ type: "client_register", clientId, sessions: {} }));
    await waitForMessage(client1); // new
    client1.send(JSON.stringify({ type: "proxy_select", proxyId }));
    await settle();

    const liveMsgs = collectMessages(client1, 3);
    proxy.send(JSON.stringify(makeEnvelope(1)));
    proxy.send(JSON.stringify(makeEnvelope(2)));
    proxy.send(JSON.stringify(makeEnvelope(3)));
    await liveMsgs;

    client1.close();
    await settle();

    const client2 = ws.client(port);
    await waitForOpen(client2);
    const allMsgs = collectMessages(client2, 3);
    client2.send(JSON.stringify({ type: "client_register", clientId, sessions: { s1: 1 } }));
    const received = await allMsgs;

    expect(received.length).toBe(3);
    const restored = JSON.parse(received[0]);
    expect(restored.type).toBe("client_register_response");
    expect(restored.status).toBe("restored");
    expect(JSON.parse(received[1]).seq).toBe(2);
    expect(JSON.parse(received[2]).seq).toBe(3);
  }, E2E_TIMEOUT);

  it("Client 断线重连（proxy 离线）→ proxy_offline + 等 proxy_online", async () => {
    const proxyId = uid();
    const clientId = uid("c");

    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    const client1 = ws.client(port);
    await waitForOpen(client1);
    client1.send(JSON.stringify({ type: "client_register", clientId, sessions: {} }));
    await waitForMessage(client1);
    client1.send(JSON.stringify({ type: "proxy_select", proxyId }));
    await settle();

    client1.close();
    await settle();
    proxy.close();
    await settle(200);

    const client2 = ws.client(port);
    await waitForOpen(client2);
    const msgP = waitForMessage(client2);
    client2.send(JSON.stringify({ type: "client_register", clientId, sessions: {} }));
    const resp = JSON.parse(await msgP);
    expect(resp.status).toBe("proxy_offline");

    // proxy 重连 → client 收到 proxy_online（跳过 broadcast 的 proxy_list_response）
    const onlineP = waitForMessageType(client2, "proxy_online");
    const proxy2 = ws.proxy(port);
    await waitForOpen(proxy2);
    proxy2.send(JSON.stringify({ type: "proxy_register", proxyId }));
    expect(JSON.parse(await onlineP).type).toBe("proxy_online");
  }, E2E_TIMEOUT);

  it("全新 clientId → new", async () => {
    const client = ws.client(port);
    await waitForOpen(client);
    const msgP = waitForMessage(client);
    client.send(JSON.stringify({ type: "client_register", clientId: uid("fresh"), sessions: {} }));
    const resp = JSON.parse(await msgP);
    expect(resp.type).toBe("client_register_response");
    expect(resp.status).toBe("new");
  }, E2E_TIMEOUT);

  it("Proxy 离线期间 client 发消息 → PROXY_OFFLINE", async () => {
    const proxyId = uid();
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId }));
    await settle();

    proxy.close();
    await settle(200);

    const msgP = waitForMessage(client);
    client.send(JSON.stringify(makeEnvelope(1, "s1", "user_input", "client")));
    const resp = JSON.parse(await msgP);
    expect(resp.type).toBe("relay_error");
    expect(resp.code).toBe("PROXY_OFFLINE");
  }, E2E_TIMEOUT);

  it("未绑定 client 发消息 → NOT_BOUND", async () => {
    const client = ws.client(port);
    await waitForOpen(client);
    const msgP = waitForMessage(client);
    client.send(JSON.stringify(makeEnvelope(1, "s1", "user_input", "client")));
    const resp = JSON.parse(await msgP);
    expect(resp.type).toBe("relay_error");
    expect(resp.code).toBe("NOT_BOUND");
  }, E2E_TIMEOUT);

  it("Client 发不支持的控制消息 → UNSUPPORTED", async () => {
    const client = ws.client(port);
    await waitForOpen(client);
    const msgP = waitForMessage(client);
    // proxy_register 是 proxy 端控制消息，client 端不应发送
    client.send(JSON.stringify({ type: "proxy_register", proxyId: "x" }));
    const resp = JSON.parse(await msgP);
    expect(resp.type).toBe("relay_error");
    expect(resp.code).toBe("UNSUPPORTED");
  }, E2E_TIMEOUT);

  it("Client 断线重连恢复后继续收新消息", async () => {
    const proxyId = uid();
    const clientId = uid("c");

    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    // client1 注册绑定，收到 seq 1,2
    const client1 = ws.client(port);
    await waitForOpen(client1);
    client1.send(JSON.stringify({ type: "client_register", clientId, sessions: {} }));
    await waitForMessage(client1); // new
    client1.send(JSON.stringify({ type: "proxy_select", proxyId }));
    await settle();

    const live1 = collectMessages(client1, 2);
    proxy.send(JSON.stringify(makeEnvelope(1)));
    proxy.send(JSON.stringify(makeEnvelope(2)));
    await live1;

    // client1 断开
    client1.close();
    await settle();

    // proxy 继续发 seq 3
    proxy.send(JSON.stringify(makeEnvelope(3)));
    await settle();

    // client2 重连 lastSeq=2 → 收到回放 seq3 + restored
    const client2 = ws.client(port);
    await waitForOpen(client2);
    const restoreMsgs = collectMessages(client2, 2);
    client2.send(JSON.stringify({ type: "client_register", clientId, sessions: { s1: 2 } }));
    const restored = await restoreMsgs;
    expect(JSON.parse(restored[0]).status).toBe("restored");
    expect(JSON.parse(restored[1]).seq).toBe(3);

    // 关键：恢复后继续收新消息
    const newMsgP = waitForMessage(client2);
    proxy.send(JSON.stringify(makeEnvelope(4)));
    const newMsg = JSON.parse(await newMsgP);
    expect(newMsg.seq).toBe(4);
    expect(newMsg.type).toBe("assistant_message");
  }, E2E_TIMEOUT);

  it("client_register_response 带 per-session 最新 seq（进度感知）", async () => {
    const proxyId = uid();
    const clientId = uid("c");

    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    // 发送多 session 消息
    proxy.send(JSON.stringify(makeEnvelope(1, "progress-a")));
    proxy.send(JSON.stringify(makeEnvelope(2, "progress-a")));
    proxy.send(JSON.stringify(makeEnvelope(5, "progress-a")));
    proxy.send(JSON.stringify(makeEnvelope(1, "progress-b")));
    proxy.send(JSON.stringify(makeEnvelope(3, "progress-b")));
    await settle();

    // client 绑定
    const client1 = ws.client(port);
    await waitForOpen(client1);
    client1.send(JSON.stringify({ type: "client_register", clientId, sessions: {} }));
    await waitForMessage(client1); // new
    client1.send(JSON.stringify({ type: "proxy_select", proxyId }));
    await settle();

    // 断开后重连
    client1.close();
    await settle();

    const client2 = ws.client(port);
    await waitForOpen(client2);
    const msgP = waitForMessage(client2);
    client2.send(JSON.stringify({ type: "client_register", clientId, sessions: { "progress-a": 2 } }));
    const resp = JSON.parse(await msgP);

    expect(resp.type).toBe("client_register_response");
    expect(resp.status).toBe("restored");
    // sessions 字段包含各 session 的最新 seq
    expect(resp.sessions["progress-a"]).toBe(5);
    expect(resp.sessions["progress-b"]).toBe(3);
  }, E2E_TIMEOUT);
});

describe("message buffering and replay", () => {
  let relay: ChildProcess;
  let port: number;
  const ws = createSocketTracker();
  let n = 0;
  const uid = () => `p3-${++n}`;

  beforeAll(async () => {
    port = await findFreePort();
    relay = spawnRelay({ port });
    await waitForReady(port);
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await ws.cleanup();
    killRelay(relay, "SIGTERM");
    await waitForExit(relay);
  });

  afterEach(async () => { await ws.cleanup(); });

  it("消息缓冲到 per-session buffer + /status totalBuffered", async () => {
    const proxyId = uid();
    const sidA = `buf-${proxyId}-a`;
    const sidB = `buf-${proxyId}-b`;
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    const beforeStatus = await fetchJson(port, "/status") as { buffers: { totalBuffered: number } };

    proxy.send(JSON.stringify(makeEnvelope(1, sidA)));
    proxy.send(JSON.stringify(makeEnvelope(2, sidA)));
    proxy.send(JSON.stringify(makeEnvelope(1, sidB)));
    await settle();

    const afterStatus = await fetchJson(port, "/status") as { buffers: { totalBuffered: number } };
    expect(afterStatus.buffers.totalBuffered).toBe(beforeStatus.buffers.totalBuffered + 3);
  }, E2E_TIMEOUT);

  it("buffer 纯追加不压缩 → 所有消息保留", async () => {
    const proxyId = uid();
    const sid = `nocompress-${proxyId}`;
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    const beforeStatus = await fetchJson(port, "/status") as { buffers: { totalBuffered: number } };

    proxy.send(JSON.stringify(makeEnvelope(1, sid)));
    proxy.send(JSON.stringify(makeEnvelope(2, sid)));
    proxy.send(JSON.stringify(makeEnvelope(3, sid)));
    proxy.send(JSON.stringify(makeEnvelope(4, sid)));
    await settle();

    const afterStatus = await fetchJson(port, "/status") as { buffers: { totalBuffered: number } };
    // 所有 4 条消息都保留在 buffer 中，不做压缩
    expect(afterStatus.buffers.totalBuffered).toBe(beforeStatus.buffers.totalBuffered + 4);
  }, E2E_TIMEOUT);

  it("JSON 模式不压缩 → 所有消息完整保留", async () => {
    const proxyId = uid();
    const sid = `s-json-${n}`;
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    for (let i = 1; i <= 10; i++) {
      proxy.send(JSON.stringify(makeEnvelope(i, sid)));
    }
    await settle();

    // 通过 replay 验证所有 10 条都在
    const client = ws.client(port);
    await waitForOpen(client);
    const replayMsgs = collectMessages(client, 10);
    client.send(JSON.stringify({ type: "replay_request", sessionId: sid, fromSeq: 1, toSeq: 10 }));
    const received = await replayMsgs;
    expect(received.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(JSON.parse(received[i]).seq).toBe(i + 1);
    }
  }, E2E_TIMEOUT);

  it("seq 去重 → 重复 seq 不入 buffer", async () => {
    const proxyId = uid();
    const sid = `s-dedup-${n}`;
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    proxy.send(JSON.stringify(makeEnvelope(1, sid)));
    proxy.send(JSON.stringify(makeEnvelope(2, sid)));
    proxy.send(JSON.stringify(makeEnvelope(3, sid)));
    // 重发旧 seq
    proxy.send(JSON.stringify(makeEnvelope(2, sid)));
    proxy.send(JSON.stringify(makeEnvelope(1, sid)));
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);
    // 请求 1-10，实际只有 1,2,3
    const msgs = collectMessages(client, 3);
    client.send(JSON.stringify({ type: "replay_request", sessionId: sid, fromSeq: 1, toSeq: 10 }));
    const received = await msgs;
    // 收到 3 条消息 + 可能的 gap_unrecoverable
    const envelopes = received.map((r) => JSON.parse(r)).filter((m) => m.seq !== undefined);
    expect(envelopes.length).toBe(3);
    expect(envelopes.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3]);
  }, E2E_TIMEOUT);

  it("replay_request 成功回放", async () => {
    const proxyId = uid();
    const sid = `s-replay-${n}`;
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    for (let i = 1; i <= 5; i++) {
      proxy.send(JSON.stringify(makeEnvelope(i, sid)));
    }
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);
    const msgs = collectMessages(client, 3);
    client.send(JSON.stringify({ type: "replay_request", sessionId: sid, fromSeq: 2, toSeq: 4 }));
    const received = await msgs;
    expect(received.length).toBe(3);
    expect(JSON.parse(received[0]).seq).toBe(2);
    expect(JSON.parse(received[1]).seq).toBe(3);
    expect(JSON.parse(received[2]).seq).toBe(4);
  }, E2E_TIMEOUT);

  it("replay_request 不传 toSeq → 自动同步到最新", async () => {
    const proxyId = uid();
    const sid = `s-noto-${n}`;
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    for (let i = 1; i <= 5; i++) {
      proxy.send(JSON.stringify(makeEnvelope(i, sid)));
    }
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);
    // 不传 toSeq，从 seq 3 同步到最新
    const msgs = collectMessages(client, 3);
    client.send(JSON.stringify({ type: "replay_request", sessionId: sid, fromSeq: 3 }));
    const received = await msgs;
    expect(received.length).toBe(3);
    expect(JSON.parse(received[0]).seq).toBe(3);
    expect(JSON.parse(received[1]).seq).toBe(4);
    expect(JSON.parse(received[2]).seq).toBe(5);
  }, E2E_TIMEOUT);

  it("replay_request 部分可用 → 消息 + gap_unrecoverable", async () => {
    const proxyId = uid();
    const sid = `s-partial-${n}`;
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy);
    await settle();

    for (let i = 3; i <= 5; i++) {
      proxy.send(JSON.stringify(makeEnvelope(i, sid)));
    }
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);
    const msgs = collectMessages(client, 4);
    client.send(JSON.stringify({ type: "replay_request", sessionId: sid, fromSeq: 1, toSeq: 5 }));
    const received = await msgs;
    expect(received.length).toBe(4);
    expect(JSON.parse(received[0]).seq).toBe(3);
    expect(JSON.parse(received[1]).seq).toBe(4);
    expect(JSON.parse(received[2]).seq).toBe(5);
    const gap = JSON.parse(received[3]);
    expect(gap.type).toBe("gap_unrecoverable");
    expect(gap.fromSeq).toBe(1);
    expect(gap.toSeq).toBe(2);
  }, E2E_TIMEOUT);

  it("replay_request 完全不可用 → gap_unrecoverable", async () => {
    const client = ws.client(port);
    await waitForOpen(client);
    const msgP = waitForMessage(client);
    client.send(JSON.stringify({ type: "replay_request", sessionId: "nonexistent-xyz", fromSeq: 1, toSeq: 10 }));
    const resp = JSON.parse(await msgP);
    expect(resp.type).toBe("gap_unrecoverable");
  }, E2E_TIMEOUT);

  it("replay_request 无效范围 → INVALID_RANGE", async () => {
    const client = ws.client(port);
    await waitForOpen(client);
    const msgP = waitForMessage(client);
    client.send(JSON.stringify({ type: "replay_request", sessionId: "s1", fromSeq: 10, toSeq: 5 }));
    const resp = JSON.parse(await msgP);
    expect(resp.type).toBe("relay_error");
    expect(resp.code).toBe("INVALID_RANGE");
  }, E2E_TIMEOUT);
});

describe("per-session seq numbering", () => {
  let relay: ChildProcess;
  let port: number;
  const ws = createSocketTracker();

  beforeAll(async () => {
    port = await findFreePort();
    relay = spawnRelay({ port });
    await waitForReady(port);
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await ws.cleanup();
    killRelay(relay, "SIGTERM");
    await waitForExit(relay);
  });

  afterEach(async () => { await ws.cleanup(); });

  it("Per-session seq 独立", async () => {
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p5-seq" }));
    await waitForMessage(proxy);
    await settle();

    proxy.send(JSON.stringify(makeEnvelope(1, "seq-a")));
    proxy.send(JSON.stringify(makeEnvelope(2, "seq-a")));
    proxy.send(JSON.stringify(makeEnvelope(3, "seq-a")));
    proxy.send(JSON.stringify(makeEnvelope(1, "seq-b")));
    proxy.send(JSON.stringify(makeEnvelope(2, "seq-b")));
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);

    // session seq-a: 3 条
    const msgsA = collectMessages(client, 3);
    client.send(JSON.stringify({ type: "replay_request", sessionId: "seq-a", fromSeq: 1, toSeq: 3 }));
    expect((await msgsA).length).toBe(3);

    // session seq-b: 2 条（独立编号）
    const msgsB = collectMessages(client, 2);
    client.send(JSON.stringify({ type: "replay_request", sessionId: "seq-b", fromSeq: 1, toSeq: 2 }));
    expect((await msgsB).length).toBe(2);
  }, E2E_TIMEOUT);

  it("重连对账 → sessions 返回 per-session lastSeq", async () => {
    const proxyId = "p5-recon";
    const proxy1 = ws.proxy(port);
    await waitForOpen(proxy1);
    proxy1.send(JSON.stringify({ type: "proxy_register", proxyId }));
    await waitForMessage(proxy1);
    await settle();

    proxy1.send(JSON.stringify(makeEnvelope(10, "recon-a")));
    proxy1.send(JSON.stringify(makeEnvelope(20, "recon-a")));
    proxy1.send(JSON.stringify(makeEnvelope(5, "recon-b")));
    await settle();

    proxy1.close();
    await settle(200);

    const proxy2 = ws.proxy(port);
    await waitForOpen(proxy2);
    const msgP = waitForMessage(proxy2);
    proxy2.send(JSON.stringify({ type: "proxy_register", proxyId }));
    const resp = JSON.parse(await msgP);
    expect(resp.sessions).toEqual({ "recon-a": 20, "recon-b": 5 });
  }, E2E_TIMEOUT);
});

// ── 六: 持久化与 Relay 重启 ─────────────────────────────
// 每个测试管理自己的 relay 进程

describe("disk persistence and relay restart", () => {
  const ws = createSocketTracker();
  const procs: ChildProcess[] = [];

  afterEach(async () => {
    await ws.cleanup();
    for (const p of procs) {
      if (!p.killed && p.exitCode === null) {
        killRelay(p);
        await waitForExit(p);
      }
    }
    procs.length = 0;
  });

  it("磁盘持久化 → NDJSON 文件逐行追加", async () => {
    const port = await findFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), "relay-e2e-"));
    const relay = spawnRelay({ port, dataDir });
    procs.push(relay);
    await waitForReady(port);

    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p6-1" }));
    await waitForMessage(proxy);
    await settle();

    proxy.send(JSON.stringify(makeEnvelope(1, "disk-1")));
    proxy.send(JSON.stringify(makeEnvelope(2, "disk-1")));
    await settle();

    const ndjsonPath = join(dataDir, "disk-1.ndjson");
    expect(existsSync(ndjsonPath)).toBe(true);
    const lines = readFileSync(ndjsonPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).seq).toBe(1);
    expect(JSON.parse(lines[1]).seq).toBe(2);
  }, E2E_TIMEOUT);

  it("磁盘 NDJSON 纯追加 → 所有消息持久化", async () => {
    const port = await findFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), "relay-e2e-"));
    const relay = spawnRelay({ port, dataDir });
    procs.push(relay);
    await waitForReady(port);

    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p6-2" }));
    await waitForMessage(proxy);
    await settle();

    const sid = "disk-pty";
    proxy.send(JSON.stringify(makeEnvelope(1, sid)));
    proxy.send(JSON.stringify(makeEnvelope(2, sid)));
    proxy.send(JSON.stringify(makeEnvelope(3, sid)));
    proxy.send(JSON.stringify(makeEnvelope(4, sid)));
    await settle();

    const path = join(dataDir, `${sid}.ndjson`);
    const afterLines = readFileSync(path, "utf-8").trim().split("\n");
    // 所有 4 条消息都持久化，不做压缩
    expect(afterLines.length).toBe(4);
    expect(JSON.parse(afterLines[0]).seq).toBe(1);
    expect(JSON.parse(afterLines[3]).seq).toBe(4);
  }, E2E_TIMEOUT);

  it("Proxy 主动退出 → NDJSON 文件被删除", async () => {
    const port = await findFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), "relay-e2e-"));
    const relay = spawnRelay({ port, dataDir });
    procs.push(relay);
    await waitForReady(port);

    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p6-3" }));
    await waitForMessage(proxy);
    await settle();

    proxy.send(JSON.stringify(makeEnvelope(1, "disk-del-a")));
    proxy.send(JSON.stringify(makeEnvelope(1, "disk-del-b")));
    await settle();

    expect(existsSync(join(dataDir, "disk-del-a.ndjson"))).toBe(true);
    expect(existsSync(join(dataDir, "disk-del-b.ndjson"))).toBe(true);

    proxy.send(JSON.stringify({ type: "proxy_disconnect", proxyId: "p6-3" }));
    await settle();

    expect(existsSync(join(dataDir, "disk-del-a.ndjson"))).toBe(false);
    expect(existsSync(join(dataDir, "disk-del-b.ndjson"))).toBe(false);
  }, E2E_TIMEOUT);

  it("SIGKILL 崩溃 → 磁盘数据存活 → 新进程加载恢复 → replay 可用", async () => {
    const port = await findFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), "relay-e2e-"));

    // 第一个 relay
    const relay1 = spawnRelay({ port, dataDir });
    procs.push(relay1);
    await waitForReady(port);

    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p6-4" }));
    await waitForMessage(proxy);
    await settle();

    proxy.send(JSON.stringify(makeEnvelope(1, "crash-s")));
    proxy.send(JSON.stringify(makeEnvelope(2, "crash-s")));
    proxy.send(JSON.stringify(makeEnvelope(3, "crash-s")));
    await settle();

    expect(readFileSync(join(dataDir, "crash-s.ndjson"), "utf-8").trim().split("\n").length).toBe(3);

    // SIGKILL：不执行 cleanup 代码
    killRelay(relay1);
    await waitForExit(relay1);
    await ws.cleanup();

    // 数据还在
    expect(existsSync(join(dataDir, "crash-s.ndjson"))).toBe(true);

    // 第二个 relay（同端口、同 dataDir）
    const relay2 = spawnRelay({ port, dataDir });
    procs.push(relay2);
    await waitForReady(port);

    // /status 反映加载的数据
    const status = await fetchJson(port, "/status") as { buffers: { totalBuffered: number } };
    expect(status.buffers.totalBuffered).toBe(3);

    // replay 获取崩溃前数据
    const client = ws.client(port);
    await waitForOpen(client);
    const msgs = collectMessages(client, 3);
    client.send(JSON.stringify({ type: "replay_request", sessionId: "crash-s", fromSeq: 1, toSeq: 3 }));
    const received = await msgs;
    expect(received.length).toBe(3);
    expect(JSON.parse(received[0]).seq).toBe(1);
    expect(JSON.parse(received[1]).seq).toBe(2);
    expect(JSON.parse(received[2]).seq).toBe(3);
  }, E2E_TIMEOUT);

  it("Relay 重启已知限制 → proxy-session 映射丢失 → status=new", async () => {
    const port = await findFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), "relay-e2e-"));

    const relay1 = spawnRelay({ port, dataDir });
    procs.push(relay1);
    await waitForReady(port);

    const proxy1 = ws.proxy(port);
    await waitForOpen(proxy1);
    proxy1.send(JSON.stringify({ type: "proxy_register", proxyId: "p6-5" }));
    await waitForMessage(proxy1);
    await settle();

    proxy1.send(JSON.stringify(makeEnvelope(1, "limit-s")));
    await settle();

    killRelay(relay1);
    await waitForExit(relay1);
    await ws.cleanup();

    const relay2 = spawnRelay({ port, dataDir });
    procs.push(relay2);
    await waitForReady(port);

    // proxy 重连 → status=new（映射丢失）
    const proxy2 = ws.proxy(port);
    await waitForOpen(proxy2);
    const msgP = waitForMessage(proxy2);
    proxy2.send(JSON.stringify({ type: "proxy_register", proxyId: "p6-5" }));
    const resp = JSON.parse(await msgP);
    expect(resp.status).toBe("new");
    expect(resp.sessions).toBeUndefined();

    // 但 buffer 数据仍可通过 replay 获取
    const client = ws.client(port);
    await waitForOpen(client);
    const msgs = collectMessages(client, 1);
    client.send(JSON.stringify({ type: "replay_request", sessionId: "limit-s", fromSeq: 1, toSeq: 1 }));
    expect((await msgs).length).toBe(1);
  }, E2E_TIMEOUT);

  it("SIGTERM 优雅关闭 → 进程正常退出（exit code 0）", async () => {
    const port = await findFreePort();
    const relay = spawnRelay({ port });
    procs.push(relay);
    await waitForReady(port);

    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "p-sigterm" }));
    await waitForMessage(proxy);

    killRelay(relay, "SIGTERM");
    const exitCode = await waitForExit(relay, 5000);
    expect(exitCode).toBe(0);
  }, E2E_TIMEOUT);
});

// ── 七: 心跳检测 ────────────────────────────────────────

describe("heartbeat dead connection detection", () => {
  let relay: ChildProcess;
  let port: number;
  const ws = createSocketTracker();

  beforeAll(async () => {
    port = await findFreePort();
    // 500ms 心跳间隔加速测试
    relay = spawnRelay({ port, heartbeatInterval: 500 });
    await waitForReady(port);
  }, E2E_TIMEOUT);

  afterAll(async () => {
    await ws.cleanup();
    killRelay(relay, "SIGTERM");
    await waitForExit(relay);
  });

  afterEach(async () => { await ws.cleanup(); });

  it("Proxy 心跳超时 → terminate → proxy_offline", async () => {
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "hb-p" }));
    await waitForMessage(proxy);
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "hb-p" }));
    await settle();

    // 禁用 pong 模拟死连接（TCP 层面无法在测试中真正断网，这是最接近的方式）
    proxy.pong = () => {};
    proxy.on("ping", () => { /* 不回复 */ });

    const offlineMsg = JSON.parse(await waitForMessage(client));
    expect(offlineMsg.type).toBe("proxy_offline");
    expect(offlineMsg.proxyId).toBe("hb-p");
  }, E2E_TIMEOUT);

  it("Client 心跳超时 → terminate → 绑定保留", async () => {
    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "hb-c" }));
    await waitForMessage(proxy);
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "client_register", clientId: "hb-c1", sessions: {} }));
    await waitForMessage(client);
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "hb-c" }));
    await settle();

    client.pong = () => {};
    client.on("ping", () => { /* 不回复 */ });

    // 等待心跳 terminate client
    await waitForClose(client);

    // 绑定保留：用同一 clientId 重连得到 restored
    const client2 = ws.client(port);
    await waitForOpen(client2);
    const msgP = waitForMessage(client2);
    client2.send(JSON.stringify({ type: "client_register", clientId: "hb-c1", sessions: {} }));
    const resp = JSON.parse(await msgP);
    expect(resp.status).toBe("restored");
    expect(resp.proxyId).toBe("hb-c");
  }, E2E_TIMEOUT);
});

// ── 八: 端到端场景：网络中断恢复 ────────────────────────

describe("end-to-end: network interruption recovery and multi-session", () => {
  const ws = createSocketTracker();
  const procs: ChildProcess[] = [];

  afterEach(async () => {
    await ws.cleanup();
    for (const p of procs) {
      if (!p.killed && p.exitCode === null) {
        killRelay(p);
        await waitForExit(p);
      }
    }
    procs.length = 0;
  });

  it("网络中断 → 检测 → 状态保留 → 重连 → 恢复 → 消息路由正常", async () => {
    const port = await findFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), "relay-e2e-"));
    const relay = spawnRelay({ port, dataDir, heartbeatInterval: 500 });
    procs.push(relay);
    await waitForReady(port);

    // -- 阶段 1: 正常工作 --
    const proxy1 = ws.proxy(port);
    await waitForOpen(proxy1);
    proxy1.send(JSON.stringify({ type: "proxy_register", proxyId: "cable" }));
    await waitForMessage(proxy1);
    await settle();

    const client = ws.client(port);
    await waitForOpen(client);
    client.send(JSON.stringify({ type: "client_register", clientId: "cable-c", sessions: {} }));
    await waitForMessage(client); // new
    client.send(JSON.stringify({ type: "proxy_select", proxyId: "cable" }));
    await settle();

    const liveMsgs = collectMessages(client, 3);
    proxy1.send(JSON.stringify(makeEnvelope(1, "cable-s")));
    proxy1.send(JSON.stringify(makeEnvelope(2, "cable-s")));
    proxy1.send(JSON.stringify(makeEnvelope(3, "cable-s")));
    await liveMsgs;

    // -- 阶段 2: 网络中断（禁用 pong） --
    proxy1.pong = () => {};
    proxy1.on("ping", () => {});

    const offlineMsg = JSON.parse(await waitForMessageType(client, "proxy_offline"));
    expect(offlineMsg.type).toBe("proxy_offline");

    // -- 阶段 3: 状态保留 --
    // 数据在磁盘上
    expect(existsSync(join(dataDir, "cable-s.ndjson"))).toBe(true);
    const status = await fetchJson(port, "/status") as { buffers: { totalBuffered: number } };
    expect(status.buffers.totalBuffered).toBeGreaterThanOrEqual(3);

    // -- 阶段 4: proxy 重连 --
    const onlinePromise = waitForMessageType(client, "proxy_online");
    const proxy2 = ws.proxy(port);
    await waitForOpen(proxy2);

    const registerP = waitForMessage(proxy2);
    proxy2.send(JSON.stringify({ type: "proxy_register", proxyId: "cable" }));

    const resp = JSON.parse(await registerP);
    expect(resp.status).toBe("reconnected");
    expect(resp.sessions["cable-s"]).toBe(3);

    const onlineMsg = JSON.parse(await onlinePromise);
    expect(onlineMsg.type).toBe("proxy_online");

    // -- 阶段 5: 恢复后消息路由正常 --
    const newMsgP = waitForMessageType(client, "assistant_message");
    proxy2.send(JSON.stringify(makeEnvelope(4, "cable-s")));
    const newMsg = JSON.parse(await newMsgP);
    expect(newMsg.seq).toBe(4);
    expect(newMsg.type).toBe("assistant_message");
  }, E2E_TIMEOUT);

  it("Proxy 管理多 session → client 收到所有 session + 断线恢复各 session 独立回放", async () => {
    const port = await findFreePort();
    const dataDir = mkdtempSync(join(tmpdir(), "relay-e2e-"));
    const relay = spawnRelay({ port, dataDir });
    procs.push(relay);
    await waitForReady(port);

    const proxy = ws.proxy(port);
    await waitForOpen(proxy);
    proxy.send(JSON.stringify({ type: "proxy_register", proxyId: "multi" }));
    await waitForMessage(proxy);
    await settle();

    const clientId = "multi-c";
    const client1 = ws.client(port);
    await waitForOpen(client1);
    client1.send(JSON.stringify({ type: "client_register", clientId, sessions: {} }));
    await waitForMessage(client1); // new
    client1.send(JSON.stringify({ type: "proxy_select", proxyId: "multi" }));
    await settle();

    // proxy 交替发送 3 个 session 的消息
    const allLive = collectMessages(client1, 6);
    proxy.send(JSON.stringify(makeEnvelope(1, "sa")));
    proxy.send(JSON.stringify(makeEnvelope(1, "sb")));
    proxy.send(JSON.stringify(makeEnvelope(2, "sa")));
    proxy.send(JSON.stringify(makeEnvelope(1, "sc")));
    proxy.send(JSON.stringify(makeEnvelope(3, "sa")));
    proxy.send(JSON.stringify(makeEnvelope(2, "sb")));
    const liveReceived = await allLive;
    expect(liveReceived.length).toBe(6);

    // client 断开
    client1.close();
    await settle();

    // proxy 继续发
    proxy.send(JSON.stringify(makeEnvelope(4, "sa")));
    proxy.send(JSON.stringify(makeEnvelope(3, "sb")));
    await settle();

    // client 重连，lastSeq=0 → 收到所有 session 的全量回放
    const client2 = ws.client(port);
    await waitForOpen(client2);
    const allRestore = collectMessages(client2, 9);
    client2.send(JSON.stringify({ type: "client_register", clientId, sessions: {} }));
    const restoreReceived = await allRestore;

    const restoredResp = JSON.parse(restoreReceived[0]);
    expect(restoredResp.status).toBe("restored");

    // 回放的 8 条消息应包含所有 session
    const replayed = restoreReceived.slice(1).map((r) => JSON.parse(r));
    const saSeqs = replayed.filter((m: { sessionId: string }) => m.sessionId === "sa").map((m: { seq: number }) => m.seq);
    const sbSeqs = replayed.filter((m: { sessionId: string }) => m.sessionId === "sb").map((m: { seq: number }) => m.seq);
    const scSeqs = replayed.filter((m: { sessionId: string }) => m.sessionId === "sc").map((m: { seq: number }) => m.seq);

    expect(saSeqs).toEqual([1, 2, 3, 4]);
    expect(sbSeqs).toEqual([1, 2, 3]);
    expect(scSeqs).toEqual([1]);

    // 各 session 可独立 replay
    const replaySa = collectMessages(client2, 4);
    client2.send(JSON.stringify({ type: "replay_request", sessionId: "sa", fromSeq: 1, toSeq: 4 }));
    expect((await replaySa).length).toBe(4);

    const replaySc = collectMessages(client2, 1);
    client2.send(JSON.stringify({ type: "replay_request", sessionId: "sc", fromSeq: 1, toSeq: 1 }));
    expect((await replaySc).length).toBe(1);

    // proxy 断线重连 → sessions map 包含所有 3 个 session
    proxy.close();
    await settle(200);

    const proxy2 = ws.proxy(port);
    await waitForOpen(proxy2);
    const regP = waitForMessage(proxy2);
    proxy2.send(JSON.stringify({ type: "proxy_register", proxyId: "multi" }));
    const regResp = JSON.parse(await regP);
    expect(regResp.status).toBe("reconnected");
    expect(regResp.sessions.sa).toBe(4);
    expect(regResp.sessions.sb).toBe(3);
    expect(regResp.sessions.sc).toBe(1);

    // 磁盘上每个 session 都有独立的 NDJSON 文件
    expect(existsSync(join(dataDir, "sa.ndjson"))).toBe(true);
    expect(existsSync(join(dataDir, "sb.ndjson"))).toBe(true);
    expect(existsSync(join(dataDir, "sc.ndjson"))).toBe(true);
  }, E2E_TIMEOUT);
});
