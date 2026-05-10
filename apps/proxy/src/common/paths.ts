import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 所有 dev-anywhere 文件路径的集中定义
// 使用 os.homedir()：POSIX 走 HOME，Windows 走 USERPROFILE；未设置时回退到 getpwuid。
// 相比 process.env.HOME，不会在缺失环境变量时构造出 "undefined/.dev-anywhere"。
const HOME = homedir();
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_FONT_ASSETS_DIR = resolve(MODULE_DIR, "../../assets/fonts");
const DIST_FONT_ASSETS_DIR = resolve(MODULE_DIR, "../assets/fonts");
const DEFAULT_FONT_FAMILY = "sarasa-fixed-sc";
export const DEFAULT_PROXY_PROFILE = "default";

interface ProxyProfilePaths {
  profileName: string;
  isDefaultProfile: boolean;
  appDir: string;
  profileDir: string;
  configPath: string;
  runDir: string;
  sockPath: string;
  pidPath: string;
  stoppedPath: string;
  desiredRelayPath: string;
  stateDir: string;
  sessionsPath: string;
  hookRegistryPath: string;
  dataDir: string;
  proxyIdPath: string;
  logDir: string;
  serviceLogPath: string;
  relayDataDir: string;
  fontDir: string;
}

export function normalizeProxyProfileName(value: string | undefined): string {
  const normalized = value?.trim() || DEFAULT_PROXY_PROFILE;
  if (
    normalized === "." ||
    normalized === ".." ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(normalized)
  ) {
    throw new Error(
      `Invalid dev-anywhere profile "${normalized}". Use 1-64 letters, numbers, ".", "_" or "-".`,
    );
  }
  return normalized;
}

function readProxyProfileNameFromArgv(argv: readonly string[]): string | undefined {
  const args = [...argv];
  while (args[0] === "--") args.shift();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "claude" || arg === "codex") return undefined;
    if (arg === "--profile") {
      const next = args[i + 1];
      return next && !next.startsWith("-") ? next : undefined;
    }
    if (arg.startsWith("--profile=")) {
      return arg.slice("--profile=".length);
    }
  }
  return undefined;
}

function resolveProxyProfileName(
  argv: readonly string[] = process.argv.slice(2),
  home: string = HOME,
): string {
  return normalizeProxyProfileName(
    readProxyProfileNameFromArgv(argv) ?? readDefaultProfileFromConfig(home),
  );
}

function readDefaultProfileFromConfig(home: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(`${home}/.dev-anywhere/config.json`, "utf-8")) as {
      defaultProfile?: unknown;
    };
    return typeof parsed.defaultProfile === "string" ? parsed.defaultProfile : undefined;
  } catch {
    return undefined;
  }
}

export function buildProxyProfilePaths(home: string, profileName: string): ProxyProfilePaths {
  const normalizedProfile = normalizeProxyProfileName(profileName);
  const appDir = `${home}/.dev-anywhere`;
  const isDefaultProfile = normalizedProfile === DEFAULT_PROXY_PROFILE;
  const profileDir = isDefaultProfile ? appDir : `${appDir}/profiles/${normalizedProfile}`;
  const runDir = isDefaultProfile ? `${appDir}/run` : `${profileDir}/run`;
  const stateDir = isDefaultProfile ? `${appDir}/state` : `${profileDir}/state`;
  const dataDir = isDefaultProfile ? `${appDir}/data` : `${profileDir}/data`;
  const logDir = isDefaultProfile ? `${appDir}/logs` : `${profileDir}/logs`;
  const relayDataDir = `${appDir}/relay-data`;

  return {
    profileName: normalizedProfile,
    isDefaultProfile,
    appDir,
    profileDir,
    configPath: `${appDir}/config.json`,
    runDir,
    sockPath: `${runDir}/dev-anywhere.sock`,
    pidPath: `${runDir}/dev-anywhere.pid`,
    stoppedPath: `${runDir}/stopped`,
    desiredRelayPath: `${runDir}/desired-relay`,
    stateDir,
    sessionsPath: `${stateDir}/sessions.json`,
    hookRegistryPath: `${stateDir}/hooks.json`,
    dataDir,
    proxyIdPath: isDefaultProfile ? `${appDir}/proxy-id` : `${profileDir}/proxy-id`,
    logDir,
    serviceLogPath: `${logDir}/service.log`,
    relayDataDir,
    fontDir: `${relayDataDir}/fonts`,
  };
}

export function defaultHookPortForProfile(profileName: string): number {
  const normalizedProfile = normalizeProxyProfileName(profileName);
  if (normalizedProfile === DEFAULT_PROXY_PROFILE) return 17654;

  let hash = 0;
  for (const char of normalizedProfile) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  }
  return 17655 + hash;
}

export const PROFILE_NAME = resolveProxyProfileName();
const PROFILE_PATHS = buildProxyProfilePaths(HOME, PROFILE_NAME);

// 把 cwd 前缀替换为 ~，HOME 为空时原样返回（避免 replace("", "~") 把 ~ 前缀到所有路径）
export function tildify(cwd: string): string {
  return HOME ? cwd.replace(HOME, "~") : cwd;
}
export const CONFIG_PATH = PROFILE_PATHS.configPath;

// 运行时文件
export const RUN_DIR = PROFILE_PATHS.runDir;
export const SOCK_PATH = PROFILE_PATHS.sockPath;
export const PID_PATH = PROFILE_PATHS.pidPath;
// 停机标记文件。用户执行 `dev-anywhere stop` 时创建，其它时候不存在。文件内容无意义。
// 作用：terminal 重连逻辑检查此标记，存在则仅 tryConnect 不主动 spawn daemon，
// 防止 stop 结束 daemon 后 terminal 立即将其重新拉起。
export const STOPPED_PATH = PROFILE_PATHS.stoppedPath;
export const DESIRED_RELAY_PATH = PROFILE_PATHS.desiredRelayPath;

// 持久化状态
const STATE_DIR = PROFILE_PATHS.stateDir;
export const SESSIONS_PATH = PROFILE_PATHS.sessionsPath;
export const HOOK_REGISTRY_PATH = PROFILE_PATHS.hookRegistryPath;

// 会话数据
export const DATA_DIR = PROFILE_PATHS.dataDir;
export const PROXY_ID_PATH = PROFILE_PATHS.proxyIdPath;
const RELAY_DATA_DIR = PROFILE_PATHS.relayDataDir;
const FONT_DIR = PROFILE_PATHS.fontDir;

// 日志
export const LOG_DIR = PROFILE_PATHS.logDir;
export const SERVICE_LOG_PATH = PROFILE_PATHS.serviceLogPath;

function sessionDir(sessionId: string): string {
  return `${DATA_DIR}/${sessionId}`;
}

export function sessionPaths(sessionId: string) {
  const dir = sessionDir(sessionId);
  return {
    dir,
    workerSock: `${dir}/worker.sock`,
  };
}

export function isInitialized(): boolean {
  return existsSync(CONFIG_PATH);
}

const DEFAULT_CONFIG = `{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "relay": "cloud"
    },
    "local": {
      "relay": "local"
    }
  },
  "relays": {
    "cloud": {
      "url": "wss://dev-anywhere.example.com",
      "proxyToken": ""
    },
    "local": {
      "url": "ws://localhost:3100"
    }
  }
}
`;

type FontAssetSource = {
  dir: string;
  family?: string;
};

function copyFontFamilyIfMissing(targetFontsDir: string, source: FontAssetSource): boolean {
  const family = source.family ?? DEFAULT_FONT_FAMILY;
  const sourceFamilyDir = `${source.dir}/${family}`;
  const targetFamilyDir = `${targetFontsDir}/${family}`;
  if (existsSync(targetFamilyDir) || !existsSync(sourceFamilyDir)) return false;
  mkdirSync(targetFontsDir, { recursive: true });
  cpSync(sourceFamilyDir, targetFamilyDir, { recursive: true });
  return true;
}

export function installFontAssetsFromSources(
  targetFontsDir: string,
  sources: FontAssetSource[],
): boolean {
  for (const source of sources) {
    if (copyFontFamilyIfMissing(targetFontsDir, source)) return true;
  }
  return false;
}

function installFontAssets(): void {
  installFontAssetsFromSources(FONT_DIR, [
    { dir: SOURCE_FONT_ASSETS_DIR, family: DEFAULT_FONT_FAMILY },
    { dir: DIST_FONT_ASSETS_DIR, family: DEFAULT_FONT_FAMILY },
  ]);
}

export function initWorkspace(): void {
  ensureProfileWorkspace();
  mkdirSync(RELAY_DATA_DIR, { recursive: true });
  installFontAssets();
  if (!existsSync(CONFIG_PATH)) {
    writeFileSync(CONFIG_PATH, DEFAULT_CONFIG);
  }
}

export function ensureProfileWorkspace(): void {
  mkdirSync(RUN_DIR, { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}
