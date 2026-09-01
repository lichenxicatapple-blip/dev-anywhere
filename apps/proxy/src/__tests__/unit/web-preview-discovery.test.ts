import { describe, expect, it, vi } from "vitest";
import { CloudflaredLocator } from "#src/serve/preview/cloudflared-locator.js";
import { CpolarLocator } from "#src/serve/preview/cpolar-locator.js";
import { normalizeLocalPreviewUrl } from "#src/serve/preview/local-preview-url.js";

describe("local preview URL validation", () => {
  it("uses deterministic numeric loopback candidates and retains path/query/fragment", () => {
    expect(normalizeLocalPreviewUrl(" http://localhost:5173/admin?q=1#panel ")).toEqual({
      sourceUrl: "http://localhost:5173/admin?q=1#panel",
      connectHosts: ["127.0.0.1", "::1"],
      port: 5173,
    });
    expect(normalizeLocalPreviewUrl("http://127.0.0.1:3000").connectHosts).toEqual(["127.0.0.1"]);
    expect(normalizeLocalPreviewUrl("http://[::1]:3000").connectHosts).toEqual(["::1"]);
  });

  it.each([
    "https://localhost:5173",
    "http://192.168.1.2:5173",
    "http://example.com:5173",
    "http://user:password@localhost:5173",
    "file:///tmp/index.html",
  ])("rejects non-loopback or non-HTTP URL %s", (url) => {
    expect(() => normalizeLocalPreviewUrl(url)).toThrow();
  });
});

describe("cloudflared discovery", () => {
  it("forces login-shell PATH refresh and bounds every capability field to Shared limits", async () => {
    const refreshPath = vi.fn(async () => ({ source: "login-shell" as const, path: "/fresh/bin" }));
    const longPath = `/${"x".repeat(4_096)}`;
    const candidates = [
      longPath,
      ...Array.from({ length: 40 }, (_, index) => `/fresh/bin/cloudflared-${index}`),
      "/fresh/bin/cloudflared-0",
    ];
    const findCandidates = vi.fn((_name: string, env: NodeJS.ProcessEnv) =>
      env.PATH === "/fresh/bin" ? candidates : [],
    );
    const verifyCommand = vi.fn(async () => `cloudflared ${"v".repeat(400)}`);
    const locator = new CloudflaredLocator({
      baseEnv: { PATH: "/old/bin", SHELL: "/bin/zsh" },
      refreshPath,
      findCandidates,
      verifyCommand,
    });

    const located = await locator.inspect({ refreshPath: true });
    expect(refreshPath).toHaveBeenCalledOnce();
    expect(located.env.PATH).toBe("/fresh/bin");
    expect(located.command).toBe("/fresh/bin/cloudflared-0");
    expect(located.capability.available).toBe(true);
    expect(located.capability.version).toHaveLength(256);
    expect(located.capability.suggestions).toHaveLength(32);
    expect(located.capability.suggestions?.every((path) => path.length <= 4_096)).toBe(true);
    expect(new Set(located.capability.suggestions).size).toBe(32);

    await locator.inspect();
    expect(findCandidates).toHaveBeenCalledOnce();
  });

  it("does not cache a missing result, so a later forced refresh can find a new install", async () => {
    const refreshPath = vi.fn(async () => ({ source: "login-shell" as const, path: "/new/bin" }));
    const findCandidates = vi.fn((_name: string, env: NodeJS.ProcessEnv) =>
      env.PATH === "/new/bin" ? ["/new/bin/cloudflared"] : [],
    );
    const locator = new CloudflaredLocator({
      baseEnv: { PATH: "/old/bin", SHELL: "/bin/zsh" },
      refreshPath,
      findCandidates,
      verifyCommand: vi.fn(async () => "cloudflared version 1"),
    });

    expect((await locator.inspect()).capability.available).toBe(false);
    expect((await locator.inspect({ refreshPath: true })).capability).toMatchObject({
      available: true,
      command: "/new/bin/cloudflared",
    });
  });
});

describe("cpolar discovery", () => {
  it("refreshes the login-shell PATH and caches a verified executable", async () => {
    const refreshPath = vi.fn(async () => ({ source: "login-shell" as const, path: "/new/bin" }));
    const findCandidates = vi.fn((_name: string, env: NodeJS.ProcessEnv) =>
      env.PATH === "/new/bin" ? ["/new/bin/cpolar"] : [],
    );
    const verifyCommand = vi.fn(async () => "cpolar version 3.3.18");
    const locator = new CpolarLocator({
      baseEnv: { PATH: "/old/bin", SHELL: "/bin/zsh" },
      refreshPath,
      findCandidates,
      verifyCommand,
    });

    expect((await locator.inspect()).capability.available).toBe(false);
    expect((await locator.inspect({ refreshPath: true })).capability).toMatchObject({
      available: true,
      command: "/new/bin/cpolar",
      version: "cpolar version 3.3.18",
    });
    await locator.inspect();

    expect(refreshPath).toHaveBeenCalledOnce();
    expect(verifyCommand).toHaveBeenCalledOnce();
    expect(findCandidates).toHaveBeenCalledTimes(2);
  });

  it("bounds executable suggestions and version fields", async () => {
    const longPath = `/${"x".repeat(4_096)}`;
    const candidates = [
      longPath,
      ...Array.from({ length: 40 }, (_, index) => `/bin/cpolar-${index}`),
      "/bin/cpolar-0",
    ];
    const locator = new CpolarLocator({
      findCandidates: vi.fn(() => candidates),
      verifyCommand: vi.fn(async () => `cpolar ${"v".repeat(400)}`),
    });

    const located = await locator.inspect();
    expect(located.capability.version).toHaveLength(256);
    expect(located.capability.suggestions).toHaveLength(32);
    expect(located.capability.suggestions?.every((path) => path.length <= 4_096)).toBe(true);
    expect(new Set(located.capability.suggestions).size).toBe(32);
  });
});
