import { spawn, type ChildProcess } from "node:child_process";
import net, { type Socket } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const WEB_ROOT = resolve(REPO_ROOT, "apps/web");

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      await fetch(url)
        .then((response) => response.ok)
        .catch(() => false)
    )
      return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`PTY benchmark web server did not become ready: ${url}`);
}

interface QueuedBytes {
  socket: Socket;
  data: Buffer;
  offset: number;
  availableAt: number;
}

export interface DownlinkStats {
  configuredBytesPerSecond: number;
  configuredLatencyMs: number;
  webSocketConnections: number;
  totalBytesQueued: number;
  totalBytesDelivered: number;
  queuedBytes: number;
  peakQueuedBytes: number;
  peakQueuedChunks: number;
  firstQueuedAt: number | null;
  lastDeliveredAt: number | null;
}

class SharedDownlink {
  private readonly queue: QueuedBytes[] = [];
  private readonly timer: ReturnType<typeof setInterval>;
  private tokens = 0;
  private lastTickAt = performance.now();
  private currentQueuedBytes = 0;
  private totalBytesQueued = 0;
  private totalBytesDelivered = 0;
  private peakQueuedBytes = 0;
  private peakQueuedChunks = 0;
  private firstQueuedAt: number | null = null;
  private lastDeliveredAt: number | null = null;

  constructor(
    private readonly bytesPerSecond: number,
    private readonly latencyMs: number,
  ) {
    this.timer = setInterval(() => this.drain(), 5);
  }

  enqueue(socket: Socket, data: Buffer): void {
    if (data.byteLength === 0 || socket.destroyed) return;
    const now = performance.now();
    this.queue.push({ socket, data, offset: 0, availableAt: now + this.latencyMs });
    this.currentQueuedBytes += data.byteLength;
    this.totalBytesQueued += data.byteLength;
    this.peakQueuedBytes = Math.max(this.peakQueuedBytes, this.currentQueuedBytes);
    this.peakQueuedChunks = Math.max(this.peakQueuedChunks, this.queue.length);
    this.firstQueuedAt ??= now;
  }

  snapshot(webSocketConnections: number): DownlinkStats {
    return {
      configuredBytesPerSecond: this.bytesPerSecond,
      configuredLatencyMs: this.latencyMs,
      webSocketConnections,
      totalBytesQueued: this.totalBytesQueued,
      totalBytesDelivered: this.totalBytesDelivered,
      queuedBytes: this.currentQueuedBytes,
      peakQueuedBytes: this.peakQueuedBytes,
      peakQueuedChunks: this.peakQueuedChunks,
      firstQueuedAt: this.firstQueuedAt,
      lastDeliveredAt: this.lastDeliveredAt,
    };
  }

  destroy(): void {
    clearInterval(this.timer);
    this.queue.length = 0;
    this.currentQueuedBytes = 0;
  }

  private drain(): void {
    const now = performance.now();
    const elapsed = Math.max(0, now - this.lastTickAt);
    this.lastTickAt = now;
    // A small burst cap keeps the result stable even when the Node event loop stalls briefly.
    this.tokens = Math.min(
      this.tokens + (elapsed * this.bytesPerSecond) / 1000,
      this.bytesPerSecond * 0.05,
    );

    while (this.tokens >= 1 && this.queue.length > 0) {
      const item = this.queue[0];
      if (item.availableAt > now) return;
      if (item.socket.destroyed || !item.socket.writable) {
        this.currentQueuedBytes -= item.data.byteLength - item.offset;
        this.queue.shift();
        continue;
      }

      const remaining = item.data.byteLength - item.offset;
      const length = Math.min(remaining, Math.floor(this.tokens), 16 * 1024);
      if (length < 1) return;
      item.socket.write(item.data.subarray(item.offset, item.offset + length));
      item.offset += length;
      this.tokens -= length;
      this.currentQueuedBytes -= length;
      this.totalBytesDelivered += length;
      this.lastDeliveredAt = now;
      if (item.offset === item.data.byteLength) this.queue.shift();
    }
  }
}

export interface PtyBenchmarkGateway {
  httpUrl: string;
  stats: () => DownlinkStats;
  destroy: () => Promise<void>;
}

export async function startPtyBenchmarkGateway(options: {
  relayPort: number;
  downlinkBytesPerSecond: number;
  latencyMs: number;
}): Promise<PtyBenchmarkGateway> {
  const port = await freePort();
  const downlink = new SharedDownlink(options.downlinkBytesPerSecond, options.latencyMs);
  const sockets = new Set<Socket>();
  let webSocketConnections = 0;

  const server = net.createServer((browserSocket) => {
    sockets.add(browserSocket);
    const relaySocket = net.connect(options.relayPort, "127.0.0.1");
    sockets.add(relaySocket);
    let requestHeader = Buffer.alloc(0);
    let isWebSocket: boolean | null = null;
    let responseHeader = Buffer.alloc(0);
    let upgradeComplete = false;

    browserSocket.on("data", (data) => {
      if (isWebSocket === null) {
        requestHeader = Buffer.concat([requestHeader, data]);
        const end = requestHeader.indexOf("\r\n\r\n");
        if (end >= 0) {
          const header = requestHeader
            .subarray(0, end + 4)
            .toString("latin1")
            .toLowerCase();
          isWebSocket = header.includes("upgrade: websocket");
          if (isWebSocket) webSocketConnections += 1;
        }
      }
      relaySocket.write(data);
    });

    relaySocket.on("data", (data) => {
      if (!isWebSocket) {
        browserSocket.write(data);
        return;
      }
      if (!upgradeComplete) {
        responseHeader = Buffer.concat([responseHeader, data]);
        const end = responseHeader.indexOf("\r\n\r\n");
        if (end < 0) return;
        browserSocket.write(responseHeader.subarray(0, end + 4));
        upgradeComplete = true;
        const body = responseHeader.subarray(end + 4);
        responseHeader = Buffer.alloc(0);
        if (body.byteLength > 0) downlink.enqueue(browserSocket, body);
        return;
      }
      downlink.enqueue(browserSocket, data);
    });

    const closePair = () => {
      browserSocket.destroy();
      relaySocket.destroy();
      sockets.delete(browserSocket);
      sockets.delete(relaySocket);
    };
    browserSocket.on("error", closePair);
    relaySocket.on("error", closePair);
    browserSocket.on("close", closePair);
    relaySocket.on("close", closePair);
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });

  return {
    httpUrl: `http://127.0.0.1:${port}`,
    stats: () => downlink.snapshot(webSocketConnections),
    destroy: async () => {
      downlink.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

export interface PtyBenchmarkWeb {
  baseUrl: string;
  destroy: () => Promise<void>;
}

export async function startPtyBenchmarkWeb(relayTarget: string): Promise<PtyBenchmarkWeb> {
  const port = await freePort();
  let output = "";
  const processHandle: ChildProcess = spawn(
    "pnpm",
    [
      "--dir",
      WEB_ROOT,
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DEV_ANYWHERE_WEB_RELAY_TARGET: relayTarget },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  processHandle.stdout?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  processHandle.stderr?.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHttp(baseUrl, 20_000);
  } catch (error) {
    processHandle.kill("SIGTERM");
    throw new Error(`${String(error)}\n${output.slice(-4000)}`, { cause: error });
  }

  return {
    baseUrl,
    destroy: async () => {
      if (processHandle.exitCode !== null) return;
      processHandle.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        const timeout = setTimeout(resolveExit, 3_000);
        processHandle.once("exit", () => {
          clearTimeout(timeout);
          resolveExit();
        });
      });
    },
  };
}
