// `dev-anywhere relay token` 实现：用本地 proxyToken 向已配置的 relay
// 请求当前生效的 client token，避免运维者必须 ssh 到 VPS 读 .env。
import { loadConfig } from "./common/config.js";

interface FetchClientTokenResult {
  status: "ok" | "no_client_token";
  clientToken?: string;
}

function toHttpUrl(relayUrl: string): string {
  return relayUrl.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:").replace(/\/$/, "");
}

export async function runRelayTokenCommand(options: { relayName?: string }): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({ relayName: options.relayName });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const { relayName, relayUrl, relayToken } = config;
  if (!relayUrl) {
    console.error(
      `Relay "${relayName}" has no URL configured. Edit ~/.dev-anywhere/config.json or set RELAY_URL.`,
    );
    process.exit(1);
  }
  if (!relayToken) {
    console.error(
      `Relay "${relayName}" has no proxy token configured. The admin endpoint requires one.`,
    );
    process.exit(1);
  }

  const adminUrl = `${toHttpUrl(relayUrl)}/admin/client-token`;
  let res: Response;
  try {
    res = await fetch(adminUrl, {
      headers: { authorization: `Bearer ${relayToken}` },
      cache: "no-store",
    });
  } catch (err) {
    console.error(`Request to ${adminUrl} failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (res.status === 401) {
    console.error(
      `Relay rejected the proxy token (HTTP 401). Verify ~/.dev-anywhere/config.json matches the relay's RELAY_PROXY_TOKEN.`,
    );
    process.exit(1);
  }
  if (res.status === 204) {
    const result: FetchClientTokenResult = { status: "no_client_token" };
    printResult(relayName, relayUrl, result);
    return;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`Unexpected response from relay (HTTP ${res.status}): ${body}`);
    process.exit(1);
  }

  const json = (await res.json()) as { clientToken?: unknown };
  if (typeof json.clientToken !== "string" || json.clientToken.length === 0) {
    console.error(`Relay returned a malformed payload: ${JSON.stringify(json)}`);
    process.exit(1);
  }
  printResult(relayName, relayUrl, { status: "ok", clientToken: json.clientToken });
}

function printResult(relayName: string, relayUrl: string, result: FetchClientTokenResult): void {
  const httpBase = toHttpUrl(relayUrl);
  console.log(`Relay: ${relayName} (${relayUrl})`);
  if (result.status === "no_client_token") {
    console.log(`Token: (not configured — /client endpoint is open)`);
    console.log(`URL:   ${httpBase}/`);
    return;
  }
  console.log(`Token: ${result.clientToken}`);
  console.log(`URL:   ${httpBase}/?relayToken=${encodeURIComponent(result.clientToken!)}`);
}
