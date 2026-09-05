import { describe, expect, it } from "vitest";
import {
  buildProxyProfilePaths,
  buildSessionPaths,
  defaultHookPortForProfile,
  localIpcEndpointPath,
  normalizeProxyProfileName,
} from "#src/common/paths.js";

describe("proxy profile paths", () => {
  it("places default profile resources directly under the application directory", () => {
    const paths = buildProxyProfilePaths("/home/dev", "default", "linux");

    expect(paths.profileName).toBe("default");
    expect(paths.sockPath).toBe("/home/dev/.dev-anywhere/run/dev-anywhere.sock");
    expect(paths.pidPath).toBe("/home/dev/.dev-anywhere/run/dev-anywhere.pid");
    expect(paths.serviceControlPath).toBe("/home/dev/.dev-anywhere/run/service-control.sock");
    expect(paths.serviceRuntimeLockPath).toBe("/home/dev/.dev-anywhere/run/service-runtime.lock");
    expect(paths.serviceOperationLockPath).toBe(
      "/home/dev/.dev-anywhere/run/service-operation.lock",
    );
    expect(paths.sessionsPath).toBe("/home/dev/.dev-anywhere/state/sessions.json");
    expect(paths.historyMetadataPath).toBe("/home/dev/.dev-anywhere/state/history-metadata.json");
    expect(paths.previewsPath).toBe("/home/dev/.dev-anywhere/state/previews.json");
    expect(paths.previewRunDir).toBe("/home/dev/.dev-anywhere/run/previews");
    expect(paths.dataDir).toBe("/home/dev/.dev-anywhere/data");
    expect(paths.proxyIdPath).toBe("/home/dev/.dev-anywhere/proxy-id");
    expect(paths.serviceLogPath).toBe("/home/dev/.dev-anywhere/logs/service.log");
  });

  it("isolates non-default profiles under profile-specific paths", () => {
    const paths = buildProxyProfilePaths("/home/dev", "local", "linux");

    expect(paths.profileName).toBe("local");
    expect(paths.sockPath).toBe("/home/dev/.dev-anywhere/profiles/local/run/dev-anywhere.sock");
    expect(paths.pidPath).toBe("/home/dev/.dev-anywhere/profiles/local/run/dev-anywhere.pid");
    expect(paths.serviceControlPath).toBe(
      "/home/dev/.dev-anywhere/profiles/local/run/service-control.sock",
    );
    expect(paths.serviceRuntimeLockPath).toBe(
      "/home/dev/.dev-anywhere/profiles/local/run/service-runtime.lock",
    );
    expect(paths.serviceOperationLockPath).toBe(
      "/home/dev/.dev-anywhere/profiles/local/run/service-operation.lock",
    );
    expect(paths.sessionsPath).toBe("/home/dev/.dev-anywhere/profiles/local/state/sessions.json");
    expect(paths.historyMetadataPath).toBe(
      "/home/dev/.dev-anywhere/profiles/local/state/history-metadata.json",
    );
    expect(paths.previewsPath).toBe("/home/dev/.dev-anywhere/profiles/local/state/previews.json");
    expect(paths.previewRunDir).toBe("/home/dev/.dev-anywhere/profiles/local/run/previews");
    expect(paths.dataDir).toBe("/home/dev/.dev-anywhere/profiles/local/data");
    expect(paths.proxyIdPath).toBe("/home/dev/.dev-anywhere/profiles/local/proxy-id");
    expect(paths.serviceLogPath).toBe("/home/dev/.dev-anywhere/profiles/local/logs/service.log");
  });

  it("uses deterministic per-profile default hook ports", () => {
    expect(defaultHookPortForProfile("default")).toBe(17654);
    expect(defaultHookPortForProfile("local")).toBe(defaultHookPortForProfile("local"));
    expect(defaultHookPortForProfile("local")).not.toBe(defaultHookPortForProfile("cloud"));
  });

  it("keeps POSIX worker socket paths unchanged", () => {
    expect(buildSessionPaths("/home/dev/.dev-anywhere/data", "session-1", "darwin")).toEqual({
      dir: "/home/dev/.dev-anywhere/data/session-1",
      workerSock: "/home/dev/.dev-anywhere/data/session-1/worker.sock",
    });
  });

  it("isolates Windows pipes by user, profile, session and endpoint kind", () => {
    const user = buildProxyProfilePaths("C:\\Users\\Alice", "default", "win32");
    const profile = buildProxyProfilePaths("C:\\Users\\Alice", "local", "win32");
    const otherUser = buildProxyProfilePaths("C:\\Users\\Bob", "default", "win32");
    const endpoints = [
      user.sockPath,
      user.serviceControlPath,
      profile.sockPath,
      otherUser.sockPath,
      buildSessionPaths(user.dataDir, "session-1", "win32").workerSock,
      buildSessionPaths(user.dataDir, "session-2", "win32").workerSock,
      buildSessionPaths(profile.dataDir, "session-1", "win32").workerSock,
    ];
    expect(new Set(endpoints).size).toBe(endpoints.length);
    for (const endpoint of endpoints) {
      expect(endpoint).toMatch(/^\\\\\.\\pipe\\dev-anywhere-[a-f0-9]{64}$/);
    }
    expect(buildProxyProfilePaths("C:\\Users\\Alice", "default", "win32")).toEqual(user);
    expect(user.serviceRuntimeLockPath).not.toContain("\\pipe\\");
  });

  it("normalizes Windows case and separators without making long paths into long pipe names", () => {
    expect(localIpcEndpointPath("C:\\Users\\Alice\\run\\control.sock", "win32")).toBe(
      localIpcEndpointPath("c:/users/alice/run/control.sock", "win32"),
    );
    expect(
      localIpcEndpointPath(`C:/Users/${"测试".repeat(500)}/worker.sock`, "win32").length,
    ).toBeLessThan(100);
  });

  it("rejects profile names that would escape the profile directory", () => {
    expect(normalizeProxyProfileName("qa-1")).toBe("qa-1");
    expect(() => normalizeProxyProfileName("../local")).toThrow(/Invalid dev-anywhere profile/);
    expect(() => normalizeProxyProfileName("")).not.toThrow();
  });
});
