import { describe, expect, it } from "vitest";
import {
  buildProxyProfilePaths,
  defaultHookPortForProfile,
  normalizeProxyProfileName,
} from "#src/common/paths.js";

describe("proxy profile paths", () => {
  it("keeps the default profile on legacy paths", () => {
    const paths = buildProxyProfilePaths("/home/dev", "default");

    expect(paths.profileName).toBe("default");
    expect(paths.sockPath).toBe("/home/dev/.dev-anywhere/run/dev-anywhere.sock");
    expect(paths.pidPath).toBe("/home/dev/.dev-anywhere/run/dev-anywhere.pid");
    expect(paths.sessionsPath).toBe("/home/dev/.dev-anywhere/state/sessions.json");
    expect(paths.historyMetadataPath).toBe("/home/dev/.dev-anywhere/state/history-metadata.json");
    expect(paths.dataDir).toBe("/home/dev/.dev-anywhere/data");
    expect(paths.proxyIdPath).toBe("/home/dev/.dev-anywhere/proxy-id");
    expect(paths.serviceLogPath).toBe("/home/dev/.dev-anywhere/logs/service.log");
  });

  it("isolates non-default profiles under profile-specific paths", () => {
    const paths = buildProxyProfilePaths("/home/dev", "local");

    expect(paths.profileName).toBe("local");
    expect(paths.sockPath).toBe("/home/dev/.dev-anywhere/profiles/local/run/dev-anywhere.sock");
    expect(paths.pidPath).toBe("/home/dev/.dev-anywhere/profiles/local/run/dev-anywhere.pid");
    expect(paths.sessionsPath).toBe("/home/dev/.dev-anywhere/profiles/local/state/sessions.json");
    expect(paths.historyMetadataPath).toBe(
      "/home/dev/.dev-anywhere/profiles/local/state/history-metadata.json",
    );
    expect(paths.dataDir).toBe("/home/dev/.dev-anywhere/profiles/local/data");
    expect(paths.proxyIdPath).toBe("/home/dev/.dev-anywhere/profiles/local/proxy-id");
    expect(paths.serviceLogPath).toBe("/home/dev/.dev-anywhere/profiles/local/logs/service.log");
  });

  it("uses deterministic per-profile default hook ports", () => {
    expect(defaultHookPortForProfile("default")).toBe(17654);
    expect(defaultHookPortForProfile("local")).toBe(defaultHookPortForProfile("local"));
    expect(defaultHookPortForProfile("local")).not.toBe(defaultHookPortForProfile("cloud"));
  });

  it("rejects profile names that would escape the profile directory", () => {
    expect(normalizeProxyProfileName("qa-1")).toBe("qa-1");
    expect(() => normalizeProxyProfileName("../local")).toThrow(/Invalid dev-anywhere profile/);
    expect(() => normalizeProxyProfileName("")).not.toThrow();
  });
});
