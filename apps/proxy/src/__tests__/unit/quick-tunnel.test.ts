import { describe, expect, it } from "vitest";
import { buildQuickTunnelAccessUrl, extractTryCloudflareUrl } from "../../quick-tunnel.js";

describe("Quick Tunnel helpers", () => {
  it("extracts the generated trycloudflare.com URL from cloudflared logs", () => {
    expect(
      extractTryCloudflareUrl(
        "INF +--------------------------------------------------------------------------------------------+\nINF |  Your quick Tunnel has been created! Visit it at https://plain-dawn-123.trycloudflare.com  |\n",
      ),
    ).toBe("https://plain-dawn-123.trycloudflare.com");
  });

  it("places the client token in the URL fragment", () => {
    expect(
      buildQuickTunnelAccessUrl("https://plain-dawn-123.trycloudflare.com", "token with spaces"),
    ).toBe("https://plain-dawn-123.trycloudflare.com/#/?relayToken=token%20with%20spaces");
  });
});
