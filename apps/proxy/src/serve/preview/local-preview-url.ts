import { connect } from "node:net";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

interface NormalizedLocalPreviewUrl {
  sourceUrl: string;
  connectHosts: Array<"127.0.0.1" | "::1">;
  port: number;
}

export function normalizeLocalPreviewUrl(raw: string): NormalizedLocalPreviewUrl {
  const value = raw.trim();
  if (!value) throw new Error("请输入本地网页地址");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("本地网页地址格式不正确");
  }

  if (url.protocol !== "http:") throw new Error("本地网页地址只支持 http://");
  if (url.username || url.password) throw new Error("本地网页地址不能包含用户名或密码");
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("本地网页地址只能使用 localhost、127.0.0.1 或 [::1]");
  }

  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("本地网页地址端口无效");
  }

  const hostname = url.hostname.toLowerCase();
  const connectHosts: Array<"127.0.0.1" | "::1"> =
    hostname === "localhost"
      ? ["127.0.0.1", "::1"]
      : hostname === "[::1]" || hostname === "::1"
        ? ["::1"]
        : ["127.0.0.1"];
  return {
    sourceUrl: url.toString(),
    connectHosts,
    port,
  };
}

export async function probeLocalPreviewTarget(
  target: Pick<NormalizedLocalPreviewUrl, "connectHosts" | "port">,
  timeoutMs = 2_000,
): Promise<"127.0.0.1" | "::1"> {
  const probeHost = (host: "127.0.0.1" | "::1") =>
    new Promise<void>((resolve, reject) => {
      const socket = connect({ host, port: target.port });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () => finish(new Error("无法连接本地网页，请确认它正在运行")),
        timeoutMs,
      );
      timer.unref?.();
      socket.once("connect", () => finish());
      socket.once("error", () => finish(new Error("无法连接本地网页，请确认它正在运行")));
    });

  for (const host of target.connectHosts) {
    try {
      await probeHost(host);
      return host;
    } catch {
      // localhost intentionally tries both numeric loopback families without DNS resolution.
    }
  }
  throw new Error("无法连接本地网页，请确认它正在运行");
}
