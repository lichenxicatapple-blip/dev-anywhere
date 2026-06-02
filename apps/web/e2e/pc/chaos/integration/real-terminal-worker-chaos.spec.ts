import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test, type LocalRuntime } from "../../../fixtures/local-runtime";
import { spawnSessionViaRelay, type SessionViaRelay } from "../../../fixtures/relay-control";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const proxyDist = resolve(repoRoot, "apps/proxy/dist/index.js");
const textDecoder = new TextDecoder();

test.setTimeout(90_000);

function decodePtyFrame(buffer: ArrayBuffer): { sessionId: string; data: string } | null {
  const bytes = new Uint8Array(buffer);
  const sessionIdLength = bytes[0];
  if (!sessionIdLength || bytes.length < 1 + sessionIdLength + 4) return null;
  const sessionId = textDecoder.decode(bytes.slice(1, 1 + sessionIdLength));
  const payload = bytes.slice(1 + sessionIdLength + 4);
  return { sessionId, data: textDecoder.decode(payload) };
}

async function waitForProxyRegistered(runtime: LocalRuntime): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await fetch(`${runtime.relayHttpUrl}/api/proxies`);
        if (!response.ok) return false;
        const proxies = (await response.json()) as Array<{ online?: boolean }>;
        return proxies.some((proxy) => proxy.online !== false);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

async function restartServe(runtime: LocalRuntime): Promise<void> {
  await execFileAsync(
    "node",
    [
      proxyDist,
      "--profile",
      runtime.profileName,
      "serve",
      "restart",
      "--relay",
      runtime.profileName,
    ],
    {
      cwd: repoRoot,
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: runtime.profileHome,
        DEV_ANYWHERE_HOOK_PORT: String(runtime.hookPort),
      },
    },
  );
  await waitForProxyRegistered(runtime);
}

class PtyOutputCapture {
  private text = "";
  private requestSeq = 0;
  private snapshotCount = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly session: SessionViaRelay) {
    this.disposers.push(
      session.onBinary((buffer) => {
        const frame = decodePtyFrame(buffer);
        if (frame?.sessionId === session.sessionId) this.text += frame.data;
      }),
    );
    this.disposers.push(
      session.onJson((msg) => {
        if (msg.type !== "session_snapshot" || msg.sessionId !== session.sessionId) return;
        this.snapshotCount += 1;
        if (typeof msg.data === "string") this.text += msg.data;
      }),
    );
  }

  async waitForSnapshot(timeoutMs: number): Promise<void> {
    await this.waitForSnapshotAfter(0, timeoutMs);
  }

  async waitForSnapshotAfter(previousSnapshotCount: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.snapshotCount > previousSnapshotCount) return;
      this.requestSnapshot();
      await new Promise((resolveFn) => setTimeout(resolveFn, 250));
    }
    throw new Error("Timed out waiting for PTY snapshot");
  }

  currentSnapshotCount(): number {
    return this.snapshotCount;
  }

  async waitFor(marker: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.text.includes(marker)) return;
      this.requestSnapshot();
      await new Promise((resolveFn) => setTimeout(resolveFn, 250));
    }
    throw new Error(`Timed out waiting for PTY output marker: ${marker}`);
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
  }

  private requestSnapshot(): void {
    this.session.send({
      type: "session_subscribe",
      requestId: `terminal-worker-snapshot-${++this.requestSeq}`,
      sessionId: this.session.sessionId,
    });
  }
}

test.describe("real terminal worker chaos", () => {
  test("keeps a web-created pure terminal usable across proxy serve restart", async ({
    localRuntime,
  }) => {
    const session = await spawnSessionViaRelay(localRuntime, { kind: "terminal", mode: "pty" });
    expect(session.kind).toBe("terminal");
    expect(session.ptyOwner).toBe("local-terminal");

    const output = new PtyOutputCapture(session);
    try {
      await output.waitForSnapshot(15_000);

      const token = Date.now();
      const before = `terminal-worker-before-${token}`;
      const after = `terminal-worker-after-${token}`;
      session.send({
        type: "remote_input_raw",
        sessionId: session.sessionId,
        data: `printf '${before}\\n'; sleep 3; printf '${after}\\n'\r`,
      });
      await output.waitFor(before, 15_000);

      const snapshotCountBeforeRestart = output.currentSnapshotCount();
      await restartServe(localRuntime);

      await session.selectProxy();
      await output.waitForSnapshotAfter(snapshotCountBeforeRestart, 30_000);
      await output.waitFor(after, 30_000);
      const postRestart = `terminal-worker-post-${token}`;
      session.send({
        type: "remote_input_raw",
        sessionId: session.sessionId,
        data: `printf '${postRestart}\\n'\r`,
      });
      await output.waitFor(postRestart, 15_000);
    } finally {
      output.dispose();
      await session.terminate();
    }
  });
});
