type BrowserCrypto = Partial<Pick<Crypto, "randomUUID" | "getRandomValues">>;

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Generates an idempotency key in both secure and plain-HTTP browser contexts.
 * `crypto.randomUUID()` is unavailable on LAN HTTP origins in Safari and Chromium, while
 * `getRandomValues()` remains available in those contexts.
 */
export function createClientOperationId(
  prefix: string,
  cryptoApi: BrowserCrypto | null = globalThis.crypto ?? null,
): string {
  if (typeof cryptoApi?.randomUUID === "function") {
    try {
      return `${prefix}-${cryptoApi.randomUUID()}`;
    } catch {
      // Plain-HTTP LAN origins can expose randomUUID while rejecting calls to it.
    }
  }

  if (typeof cryptoApi?.getRandomValues === "function") {
    try {
      const bytes = new Uint8Array(16);
      cryptoApi.getRandomValues(bytes);
      // Keep the familiar UUID v4 shape without depending on crypto.randomUUID().
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      return `${prefix}-${formatUuid(bytes)}`;
    } catch {
      // Continue to the explicit unsupported-environment error below.
    }
  }

  throw new Error("当前浏览器无法生成预览操作标识");
}
