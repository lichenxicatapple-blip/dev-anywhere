import { execFileSync } from "node:child_process";
import { isIP } from "node:net";

const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];

function readMacSystemProxy(): string {
  return execFileSync("/usr/sbin/scutil", ["--proxy"], {
    encoding: "utf8",
    timeout: 1_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Present the current static macOS proxy to CLI clients that only read environment variables. */
export function withSystemHttpProxy(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  readProxy = readMacSystemProxy,
): NodeJS.ProcessEnv {
  // An explicit route (including an empty value) wins as a whole over the fallback.
  if (platform !== "darwin" || proxyKeys.some((key) => key in env || key.toLowerCase() in env)) {
    return env;
  }

  let settings: string;
  try {
    settings = readProxy();
  } catch {
    return env;
  }
  // Restrict matching to top-level settings, outside per-interface scutil dictionaries.
  const setting = (key: string) => settings.match(new RegExp(`^  ${key} : (.+)$`, "m"))?.[1].trim();
  if (setting("ProxyAutoConfigEnable") === "1" || setting("ProxyAutoDiscoveryEnable") === "1") {
    return env;
  }

  const result = { ...env };
  let usingSystemProxy = false;
  for (const protocol of ["HTTP", "HTTPS"]) {
    if (setting(`${protocol}Enable`) !== "1") continue;
    const host = setting(`${protocol}Proxy`)?.replace(/^\[|\]$/g, "");
    const port = Number(setting(`${protocol}Port`));
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    const ipv6 = isIP(host) === 6;
    if (!ipv6 && !/^[a-z0-9.-]+$/i.test(host)) continue;
    // HTTPS requests use CONNECT through the configured HTTP proxy.
    const url = `http://${ipv6 ? `[${host}]` : host}:${port}`;
    result[`${protocol}_PROXY`] = url;
    result[`${protocol.toLowerCase()}_proxy`] = url;
    usingSystemProxy = true;
  }
  if (!usingSystemProxy) return env;

  if (env.NO_PROXY === undefined && env.no_proxy === undefined) {
    const exceptions = settings.match(
      /^ {2}ExceptionsList : <array> \{\s*\n([\s\S]*?)^ {2}\}/m,
    )?.[1];
    const hosts = [...(exceptions ?? "").matchAll(/^ {4}\d+ : ([^\s,]+)\s*$/gm)].map((entry) =>
      entry[1].replace(/^\*\./, "."),
    );
    const bypass = [...new Set(["localhost", "127.0.0.1", "::1", ...hosts])].join(",");
    result.NO_PROXY = bypass;
    result.no_proxy = bypass;
  }
  return result;
}
