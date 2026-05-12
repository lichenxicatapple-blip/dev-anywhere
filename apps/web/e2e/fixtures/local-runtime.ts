// localRuntime fixture: 起一个隔离的 relay + proxy daemon, spec 用完拆掉.
// 端口动态拿, HOME 隔离到 /tmp/dev-anywhere-e2e-XXXX, 不动用户 ~/.dev-anywhere.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { test as base } from "@playwright/test";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const RELAY_DIST = join(REPO_ROOT, "apps/relay/dist/index.js");
const PROXY_DIST = join(REPO_ROOT, "apps/proxy/dist/index.js");
// macOS unix socket sun_path 上限 104 字节. /tmp 短路径 + 短前缀, 留出 profile 段空间.
const HOME_BASE = "/tmp";
const HOME_PREFIX = "da-e2e-";
const PROFILE_NAME = "e2e";
const RELAY_NAME = "e2e";

async function getFreePort(): Promise<number> {
  return new Promise((resolveFn, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolveFn(p));
    });
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`localRuntime: ${label} 起不来 (timeout ${timeoutMs}ms)`);
}

export interface LocalRuntime {
  relayUrl: string;
  relayHttpUrl: string;
  relayPort: number;
  profileName: string;
  profileHome: string;
}

interface Fixtures {
  localRuntime: LocalRuntime;
}

export const test = base.extend<Record<never, never>, Fixtures>({
  localRuntime: [
    async ({}, use) => {
      const relayPort = await getFreePort();
      const profileHome = mkdtempSync(join(HOME_BASE, HOME_PREFIX));

      const dotDir = join(profileHome, ".dev-anywhere");
      mkdirSync(dotDir, { recursive: true });
      writeFileSync(
        join(dotDir, "config.json"),
        JSON.stringify(
          {
            defaultProfile: PROFILE_NAME,
            profiles: { [PROFILE_NAME]: { relay: RELAY_NAME } },
            relays: { [RELAY_NAME]: { url: `ws://localhost:${relayPort}` } },
          },
          null,
          2,
        ),
      );

      if (!existsSync(RELAY_DIST) || !existsSync(PROXY_DIST)) {
        throw new Error(
          `localRuntime: 需要先 \`pnpm build\` 出 dist (relay/proxy). 缺: ${
            !existsSync(RELAY_DIST) ? RELAY_DIST : PROXY_DIST
          }`,
        );
      }

      const procs: ChildProcess[] = [];
      // 默认吞日志, 调试时设 LOCAL_RUNTIME_VERBOSE=1 看 relay/proxy 输出.
      const verbose = process.env.LOCAL_RUNTIME_VERBOSE === "1";
      const captureLogs = (proc: ChildProcess, label: string) => {
        if (!verbose) return;
        proc.stdout?.on("data", (b: Buffer) => process.stdout.write(`[${label}] ${b}`));
        proc.stderr?.on("data", (b: Buffer) => process.stderr.write(`[${label}] ${b}`));
      };

      const relayProc = spawn("node", [RELAY_DIST], {
        cwd: REPO_ROOT,
        env: { ...process.env, PORT: String(relayPort) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      captureLogs(relayProc, "relay");
      procs.push(relayProc);

      const relayHttpUrl = `http://localhost:${relayPort}`;
      await waitFor(
        async () => (await fetch(`${relayHttpUrl}/health`)).ok,
        15_000,
        "relay /health",
      );

      // proxy serve start 自己 detach daemon, 父进程很快退出. 不放进 procs (杀错对象),
      // 用 serve stop 收尾.
      const proxyStart = spawn(
        "node",
        [PROXY_DIST, "--profile", PROFILE_NAME, "serve", "start", "--relay", RELAY_NAME],
        { cwd: REPO_ROOT, env: { ...process.env, HOME: profileHome }, stdio: ["ignore", "pipe", "pipe"] },
      );
      captureLogs(proxyStart, "proxy-start");
      await new Promise<void>((resolveFn, reject) => {
        proxyStart.on("exit", (code) =>
          code === 0 ? resolveFn() : reject(new Error(`proxy serve start exited ${code}`)),
        );
      });

      // proxy 注册成功 = relay /api/proxies 至少看到 1 条 (dev 模式无 token).
      await waitFor(
        async () => {
          const r = await fetch(`${relayHttpUrl}/api/proxies`);
          if (!r.ok) return false;
          const list = (await r.json()) as unknown[];
          return Array.isArray(list) && list.length > 0;
        },
        20_000,
        "proxy registers to relay",
      );

      try {
        await use({
          relayUrl: `ws://localhost:${relayPort}`,
          relayHttpUrl,
          relayPort,
          profileName: PROFILE_NAME,
          profileHome,
        });
      } finally {
        await new Promise<void>((r) => {
          const stop = spawn(
            "node",
            [PROXY_DIST, "--profile", PROFILE_NAME, "serve", "stop"],
            { cwd: REPO_ROOT, env: { ...process.env, HOME: profileHome }, stdio: "ignore" },
          );
          stop.on("exit", () => r());
          setTimeout(() => r(), 5000).unref();
        });
        for (const p of procs) {
          try {
            p.kill("SIGTERM");
          } catch {}
        }
        rmSync(profileHome, { recursive: true, force: true });
      }
    },
    { scope: "worker", timeout: 60_000 },
  ],
});

export { expect } from "@playwright/test";
