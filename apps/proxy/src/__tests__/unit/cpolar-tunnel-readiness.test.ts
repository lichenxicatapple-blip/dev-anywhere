import { describe, expect, it, vi } from "vitest";
import { waitForCpolarTunnelReachability } from "#src/common/cpolar-tunnel-readiness.js";

describe("cpolar tunnel public readiness", () => {
  it("waits for a public DNS address and a verified Gateway health response", async () => {
    const resolveAddresses = vi
      .fn<() => Promise<string[]>>()
      .mockResolvedValueOnce([])
      .mockResolvedValue(["203.0.113.10"]);
    const probeAddress = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await expect(
      waitForCpolarTunnelReachability({
        publicUrl: "https://preview-42.r5.cpolar.top",
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        retryIntervalMs: 1,
        resolveAddresses,
        probeAddress,
      }),
    ).resolves.toBeUndefined();
    expect(resolveAddresses).toHaveBeenCalledTimes(3);
    expect(probeAddress).toHaveBeenCalledWith(
      "preview-42.r5.cpolar.top",
      "203.0.113.10",
      expect.any(AbortSignal),
    );
  });

  it("rejects invalid providers and stops promptly when cancelled", async () => {
    const signal = new AbortController();
    await expect(
      waitForCpolarTunnelReachability({
        publicUrl: "https://preview-42.r5.cpolar.top.evil.test",
        signal: signal.signal,
      }),
    ).rejects.toThrow("invalid public tunnel URL");

    const pending = waitForCpolarTunnelReachability({
      publicUrl: "https://preview-42.r5.cpolar.top",
      signal: signal.signal,
      timeoutMs: 10_000,
      resolveAddresses: async () => [],
    });
    signal.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
});
