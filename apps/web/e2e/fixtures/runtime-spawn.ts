// 隔离 relay + proxy daemon spawn 工厂. localRuntime fixture (worker 共享)
// 和 chaos spec (test 独占 + 自定义 env) 都通过这个工厂起 backend.
//
// 端口动态拿, HOME 隔离到 /tmp/da-e2e-XXXX 短路径 (绕开 macOS sun_path 104 字节上限).
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const RELAY_DIST = join(REPO_ROOT, "apps/relay/dist/index.js");
const PROXY_DIST = join(REPO_ROOT, "apps/proxy/dist/index.js");
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

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`localRuntime: ${label} 起不来 (timeout ${timeoutMs}ms)`);
}

export interface SpawnOptions {
  // proxy daemon 启动时合并到子进程 env 的覆盖. chaos spec 用来注入 CLAUDE_BIN /
  // CODEX_BIN = chaos agent 路径.
  envOverride?: Record<string, string>;
}

export interface LocalRuntime {
  relayUrl: string;
  relayHttpUrl: string;
  relayPort: number;
  profileName: string;
  profileHome: string;
  // 杀 relay 进程, 让 web 进入 relay-down 状态. proxy daemon 不动.
  killRelay: () => Promise<void>;
  // 完整 teardown: 停 proxy daemon + 杀 relay + 删 profileHome. 幂等.
  destroy: () => Promise<void>;
}

export async function spawnLocalRuntime(options: SpawnOptions = {}): Promise<LocalRuntime> {
  if (!existsSync(RELAY_DIST) || !existsSync(PROXY_DIST)) {
    throw new Error(
      `localRuntime: 需要先 \`pnpm build\` 出 dist (relay/proxy). 缺: ${
        !existsSync(RELAY_DIST) ? RELAY_DIST : PROXY_DIST
      }`,
    );
  }

  const relayPort = await getFreePort();
  // hook port 默认按 profile 名 hash, 多个 worker 用同 profile 名会撞.
  // 动态分配, 通过 DEV_ANYWHERE_HOOK_PORT 透传给 daemon.
  const hookPort = await getFreePort();
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

  const relayHttpUrl = `http://localhost:${relayPort}`;
  await waitFor(async () => (await fetch(`${relayHttpUrl}/health`)).ok, 15_000, "relay /health");

  const proxyEnv = {
    ...process.env,
    HOME: profileHome,
    DEV_ANYWHERE_HOOK_PORT: String(hookPort),
    ...(options.envOverride ?? {}),
  };

  // proxy serve start 自己 detach daemon, 父进程很快退出. 不放进 procs (杀错对象),
  // 用 serve stop 收尾.
  const proxyStart = spawn(
    "node",
    [PROXY_DIST, "--profile", PROFILE_NAME, "serve", "start", "--relay", RELAY_NAME],
    {
      cwd: REPO_ROOT,
      env: proxyEnv,
      stdio: ["ignore", "pipe", "pipe"],
      // Playwright 父进程退出时, 默认 process group 内所有进程都收 SIGTERM. detached
      // 让 proxyStart 启的 daemon 进自己的 group, 测试结束才不会被连带杀掉。
      detached: true,
    },
  );
  proxyStart.unref();
  let proxyStartStderr = "";
  let proxyStartStdout = "";
  proxyStart.stdout?.on("data", (b: Buffer) => {
    proxyStartStdout += b.toString();
  });
  proxyStart.stderr?.on("data", (b: Buffer) => {
    proxyStartStderr += b.toString();
  });
  await new Promise<void>((resolveFn, reject) => {
    proxyStart.on("exit", (code) => {
      if (code === 0) {
        resolveFn();
      } else {
        const detail = `\n--- stdout ---\n${proxyStartStdout}\n--- stderr ---\n${proxyStartStderr}`;
        reject(new Error(`proxy serve start exited ${code}${detail}`));
      }
    });
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

  let relayKilled = false;
  let destroyed = false;

  const killRelay = async (): Promise<void> => {
    if (relayKilled) return;
    relayKilled = true;
    try {
      relayProc.kill("SIGTERM");
    } catch {}
    // 等监听端口断开, 给 web 一个能感知的稳定状态.
    await waitFor(
      async () => {
        try {
          const r = await fetch(`${relayHttpUrl}/health`);
          return !r.ok;
        } catch {
          return true;
        }
      },
      5_000,
      "relay /health stops responding after SIGTERM",
    ).catch(() => {});
  };

  const destroy = async (): Promise<void> => {
    if (destroyed) return;
    destroyed = true;
    try {
      await new Promise<void>((r) => {
        const stop = spawn("node", [PROXY_DIST, "--profile", PROFILE_NAME, "serve", "stop"], {
          cwd: REPO_ROOT,
          env: { ...process.env, HOME: profileHome, DEV_ANYWHERE_HOOK_PORT: String(hookPort) },
          stdio: "ignore",
        });
        stop.on("exit", () => r());
        setTimeout(() => r(), 5000).unref();
      });
    } catch {}
    try {
      relayProc.kill("SIGTERM");
    } catch {}
    rmSync(profileHome, { recursive: true, force: true });
  };

  return {
    relayUrl: `ws://localhost:${relayPort}`,
    relayHttpUrl,
    relayPort,
    profileName: PROFILE_NAME,
    profileHome,
    killRelay,
    destroy,
  };
}

export async function dumpLastFailureLog(profileHome: string): Promise<void> {
  try {
    const logDir = join(profileHome, ".dev-anywhere/profiles/e2e/logs");
    const latestPath = join(logDir, "service.log");
    if (existsSync(latestPath)) {
      const log = readFileSync(latestPath, "utf-8");
      writeFileSync("/tmp/da-e2e-last-failure.log", log);
      return;
    }

    const candidates = readdirSync(logDir)
      .filter((entry) => entry.startsWith("service-") && entry.endsWith(".log"))
      .map((entry) => {
        const path = join(logDir, entry);
        return { path, mtimeMs: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const fallback = candidates[0];
    if (!fallback) return;

    const log = readFileSync(fallback.path, "utf-8");
    writeFileSync("/tmp/da-e2e-last-failure.log", log);
  } catch {}
}
