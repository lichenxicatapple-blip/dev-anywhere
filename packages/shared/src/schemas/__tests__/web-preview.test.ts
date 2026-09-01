import { describe, expect, it } from "vitest";
import {
  isClientToProxyRelayControlType,
  isProxyToClientRelayControlType,
  RelayControlSchema,
} from "../relay-control.js";
import {
  PreviewSummarySchema,
  TunnelProviderSchema,
  WebPreviewCapabilitySchema,
  WebPreviewSourceInputSchema,
} from "../web-preview.js";

const readyPreview = {
  previewId: "preview-1",
  name: "localhost:5173",
  source: { kind: "local", url: "http://127.0.0.1:5173/admin?tab=one" },
  state: "ready",
  tunnelProvider: "cloudflare",
  publicUrl: "https://quiet-river-42.trycloudflare.com/admin?tab=one",
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_001_000,
} as const;

describe("web preview schemas", () => {
  it("reports both tunnel executables", () => {
    expect(
      WebPreviewCapabilitySchema.parse({
        supported: true,
        cloudflared: { available: true, command: "/usr/local/bin/cloudflared" },
        cpolar: { available: true, command: "/usr/local/bin/cpolar", version: "3.3.18" },
      }),
    ).toMatchObject({
      cloudflared: { available: true },
      cpolar: { available: true, command: "/usr/local/bin/cpolar" },
    });
  });

  it("accepts only supported tunnel provider ids", () => {
    expect(TunnelProviderSchema.parse("cloudflare")).toBe("cloudflare");
    expect(TunnelProviderSchema.parse("cpolar")).toBe("cpolar");
    expect(TunnelProviderSchema.safeParse("other").success).toBe(false);
  });

  it.each([
    "http://localhost:5173",
    "http://127.0.0.1:3000/admin?tab=one",
    "http://[::1]:4173/#/dashboard",
  ])("accepts loopback local source %s", (url) => {
    expect(WebPreviewSourceInputSchema.parse({ kind: "local", url })).toEqual({
      kind: "local",
      url,
    });
  });

  it.each([
    "https://localhost:5173",
    "http://192.168.1.10:5173",
    "http://localhost.example.test:5173",
    "http://user:password@localhost:5173",
  ])("rejects non-loopback or credentialed local source %s", (url) => {
    expect(() => WebPreviewSourceInputSchema.parse({ kind: "local", url })).toThrow();
  });

  it.each(["not a URL", "http://localhost:65536"])(
    "safely rejects malformed or out-of-range local URL %s",
    (url) => {
      const parse = () => WebPreviewSourceInputSchema.safeParse({ kind: "local", url });

      expect(parse).not.toThrow();
      expect(parse().success).toBe(false);
      expect(() =>
        RelayControlSchema.safeParse({
          type: "preview_create_request",
          requestId: "create-invalid-local-url",
          operationId: "create-op-invalid-local-url",
          tunnelProvider: "cloudflare",
          source: { kind: "local", url },
        }),
      ).not.toThrow();
      expect(
        RelayControlSchema.safeParse({
          type: "preview_create_request",
          requestId: "create-invalid-local-url",
          operationId: "create-op-invalid-local-url",
          tunnelProvider: "cloudflare",
          source: { kind: "local", url },
        }).success,
      ).toBe(false);
    },
  );

  it("accepts static input before inspection and normalized static summary after inspection", () => {
    expect(
      WebPreviewSourceInputSchema.parse({
        kind: "static",
        path: "./output",
        entryPath: "pages/home.html",
      }),
    ).toEqual({ kind: "static", path: "./output", entryPath: "pages/home.html" });

    expect(
      PreviewSummarySchema.parse({
        previewId: "preview-static",
        name: "home.html",
        source: {
          kind: "static",
          rootPath: "/Users/dev/project/output",
          entryPath: "pages/home.html",
        },
        state: "disconnected",
        tunnelProvider: "cloudflare",
        createdAt: 100,
        updatedAt: 200,
      }),
    ).toMatchObject({ state: "disconnected", source: { kind: "static" } });
  });

  it("accepts Cloudflare summaries and rejects invalid public URLs", () => {
    expect(PreviewSummarySchema.parse(readyPreview)).toEqual(readyPreview);

    for (const publicUrl of [
      "http://quiet-river-42.trycloudflare.com",
      "https://trycloudflare.com",
      "https://trycloudflare.com.evil.test",
      "https://quiet-river-42.trycloudflare.com.evil.test",
      "https://quiet-river-42.example.test",
      "https://user:password@quiet-river-42.trycloudflare.com",
    ]) {
      expect(() => PreviewSummarySchema.parse({ ...readyPreview, publicUrl })).toThrow();
    }
  });

  it.each([
    "preview-42.cpolar.top",
    "preview-42.r5.cpolar.top",
    "preview-42.r10.vip.cpolar.cn",
    "preview-42.r2.vip.cpolar.io",
  ])("accepts strict cpolar HTTPS subdomain %s", (hostname) => {
    const preview = {
      ...readyPreview,
      tunnelProvider: "cpolar" as const,
      publicUrl: `https://${hostname}/admin?tab=one`,
    };
    expect(PreviewSummarySchema.parse(preview)).toEqual(preview);
  });

  it("binds public URL hostnames to their declared provider and rejects malicious cpolar URLs", () => {
    const invalidPreviews = [
      {
        ...readyPreview,
        tunnelProvider: "cpolar",
        publicUrl: "https://quiet-river-42.trycloudflare.com/admin",
      },
      {
        ...readyPreview,
        tunnelProvider: "cloudflare",
        publicUrl: "https://preview-42.cpolar.top/admin",
      },
      { ...readyPreview, tunnelProvider: "cpolar", publicUrl: "http://preview-42.cpolar.top" },
      { ...readyPreview, tunnelProvider: "cpolar", publicUrl: "https://cpolar.top" },
      { ...readyPreview, tunnelProvider: "cpolar", publicUrl: "https://cpolar.cn" },
      { ...readyPreview, tunnelProvider: "cpolar", publicUrl: "https://cpolar.io" },
      {
        ...readyPreview,
        tunnelProvider: "cpolar",
        publicUrl: "https://preview-42.r5.cpolar.top.evil.test",
      },
      {
        ...readyPreview,
        tunnelProvider: "cpolar",
        publicUrl: "https://preview-42.cpolar.cn.evil.test",
      },
      {
        ...readyPreview,
        tunnelProvider: "cpolar",
        publicUrl: "https://preview-42.cpolar.io.evil.test",
      },
      {
        ...readyPreview,
        tunnelProvider: "cpolar",
        publicUrl: "https://user:password@preview-42.cpolar.top",
      },
      {
        ...readyPreview,
        tunnelProvider: "cpolar",
        publicUrl: "https://preview-42.r5.cpolar.top:8443",
      },
      {
        ...readyPreview,
        tunnelProvider: "cloudflare",
        publicUrl: "https://quiet-river-42.trycloudflare.com:8443/admin",
      },
    ];

    for (const preview of invalidPreviews) {
      expect(PreviewSummarySchema.safeParse(preview).success).toBe(false);
    }
  });

  it.each(["not a URL", "https://preview-42.r5.cpolar.top:65536"])(
    "safely rejects malformed or out-of-range public URL %s",
    (publicUrl) => {
      const preview = { ...readyPreview, tunnelProvider: "cpolar", publicUrl };
      const parsePreview = () => PreviewSummarySchema.safeParse(preview);
      const parsePush = () =>
        RelayControlSchema.safeParse({
          type: "preview_state_push",
          epoch: "proxy-epoch-invalid-public-url",
          revision: 12,
          preview,
        });

      expect(parsePreview).not.toThrow();
      expect(parsePreview().success).toBe(false);
      expect(parsePush).not.toThrow();
      expect(parsePush().success).toBe(false);
    },
  );

  it("keeps local source URLs capped at 4096 characters", () => {
    const prefix = "http://localhost/";
    const atLimit = `${prefix}${"a".repeat(4_096 - prefix.length)}`;

    expect(atLimit).toHaveLength(4_096);
    expect(WebPreviewSourceInputSchema.parse({ kind: "local", url: atLimit })).toEqual({
      kind: "local",
      url: atLimit,
    });
    expect(() =>
      WebPreviewSourceInputSchema.parse({ kind: "local", url: `${atLimit}a` }),
    ).toThrow();
  });

  it("round-trips a long percent-encoded Unicode public URL in summaries and state pushes", () => {
    const publicUrl = `https://unicode-preview.trycloudflare.com/${encodeURIComponent(
      "网页预览".repeat(1_500),
    )}`;
    const preview = { ...readyPreview, publicUrl };
    const statePush = {
      type: "preview_state_push",
      epoch: "proxy-epoch-unicode",
      revision: 10,
      preview,
    } as const;

    expect(publicUrl.length).toBeGreaterThan(4_096);
    expect(publicUrl.length).toBeLessThanOrEqual(65_536);
    expect(PreviewSummarySchema.parse(preview)).toEqual(preview);

    const parsedPush = RelayControlSchema.parse(statePush);
    const serializedPush = JSON.stringify(parsedPush);
    expect(RelayControlSchema.parse(JSON.parse(serializedPush))).toEqual(statePush);
  });

  it("rejects public URLs longer than 65536 characters and malicious hostname suffixes", () => {
    const prefix = "https://length-limit.trycloudflare.com/";
    const tooLongUrl = `${prefix}${"a".repeat(65_537 - prefix.length)}`;
    const evilSuffixUrl = "https://length-limit.trycloudflare.com.evil.test/path";

    expect(tooLongUrl).toHaveLength(65_537);
    for (const publicUrl of [tooLongUrl, evilSuffixUrl]) {
      const preview = { ...readyPreview, publicUrl };
      expect(PreviewSummarySchema.safeParse(preview).success).toBe(false);
      expect(
        RelayControlSchema.safeParse({
          type: "preview_state_push",
          epoch: "proxy-epoch-invalid-url",
          revision: 11,
          preview,
        }).success,
      ).toBe(false);
    }
  });
});

describe("web preview relay controls", () => {
  it("parses capability refresh through proxy_info", () => {
    expect(
      RelayControlSchema.parse({
        type: "proxy_info_request",
        requestId: "info-refresh",
        refreshPath: true,
      }),
    ).toEqual({ type: "proxy_info_request", requestId: "info-refresh", refreshPath: true });

    expect(
      RelayControlSchema.parse({
        type: "proxy_info",
        requestId: "info-refresh",
        homePath: "/Users/dev",
        agentCli: {
          claude: { available: true, command: "/bin/claude" },
          codex: { available: true, command: "/bin/codex" },
        },
        webPreview: {
          supported: true,
          cloudflared: {
            available: true,
            command: "/opt/homebrew/bin/cloudflared",
            version: "2026.8.1",
          },
          cpolar: { available: false, error: "cpolar not found" },
        },
      }),
    ).toMatchObject({ webPreview: { supported: true, cloudflared: { available: true } } });

    expect(
      RelayControlSchema.parse({
        type: "proxy_info",
        homePath: "/Users/dev",
        agentCli: {
          claude: { available: false },
          codex: { available: false },
        },
      }),
    ).not.toHaveProperty("webPreview");
  });

  it("parses inspect, create, list, reconnect, close and push messages", () => {
    const messages = [
      { type: "preview_static_inspect_request", requestId: "inspect-1", path: "./output" },
      {
        type: "preview_static_inspect_response",
        requestId: "inspect-1",
        success: true,
        rootPath: "/project/output",
        htmlEntries: ["home.html", "pages/about.html"],
      },
      {
        type: "preview_create_request",
        requestId: "create-1",
        operationId: "create-op-1",
        source: { kind: "static", path: "./output", entryPath: "home.html" },
        tunnelProvider: "cpolar",
      },
      {
        type: "preview_create_response",
        requestId: "create-1",
        operationId: "create-op-1",
        accepted: true,
        previewId: "preview-1",
      },
      { type: "preview_list_request", requestId: "list-1" },
      {
        type: "preview_list_response",
        requestId: "list-1",
        epoch: "proxy-epoch-1",
        revision: 3,
        previews: [readyPreview],
      },
      { type: "preview_reconnect_request", requestId: "reconnect-1", previewId: "preview-1" },
      {
        type: "preview_reconnect_response",
        requestId: "reconnect-1",
        previewId: "preview-1",
        success: true,
      },
      { type: "preview_close_request", requestId: "close-1", previewId: "preview-1" },
      {
        type: "preview_close_response",
        requestId: "close-1",
        previewId: "preview-1",
        success: true,
      },
      {
        type: "preview_state_push",
        epoch: "proxy-epoch-1",
        revision: 4,
        preview: readyPreview,
      },
      {
        type: "preview_removed_push",
        epoch: "proxy-epoch-1",
        revision: 5,
        previewId: "preview-1",
      },
    ];

    for (const message of messages) expect(RelayControlSchema.parse(message)).toEqual(message);
  });

  it("requires a tunnel provider on create requests and summaries", () => {
    const createRequestWithoutProvider = {
      type: "preview_create_request",
      requestId: "create-without-provider",
      operationId: "create-op-without-provider",
      source: { kind: "local", url: "http://localhost:5173" },
    } as const;

    expect(RelayControlSchema.safeParse(createRequestWithoutProvider).success).toBe(false);
    const summaryWithoutProvider: Record<string, unknown> = { ...readyPreview };
    delete summaryWithoutProvider.tunnelProvider;
    expect(PreviewSummarySchema.safeParse(summaryWithoutProvider).success).toBe(false);
  });

  it("requires requestId for every request and response", () => {
    const requestWithoutId = {
      type: "preview_create_request",
      operationId: "create-op-1",
      source: { kind: "local", url: "http://localhost:5173" },
    };
    const responseWithoutId = {
      type: "preview_close_response",
      previewId: "preview-1",
      success: true,
    };

    expect(() => RelayControlSchema.parse(requestWithoutId)).toThrow();
    expect(() => RelayControlSchema.parse(responseWithoutId)).toThrow();
  });

  it("marks all requests client-to-proxy and all responses/pushes proxy-to-client", () => {
    const requestTypes = [
      "preview_static_inspect_request",
      "preview_create_request",
      "preview_list_request",
      "preview_reconnect_request",
      "preview_close_request",
    ] as const;
    const responseTypes = [
      "preview_static_inspect_response",
      "preview_create_response",
      "preview_list_response",
      "preview_reconnect_response",
      "preview_close_response",
      "preview_state_push",
      "preview_removed_push",
    ] as const;

    for (const type of requestTypes) {
      expect(isClientToProxyRelayControlType(type)).toBe(true);
      expect(isProxyToClientRelayControlType(type)).toBe(false);
    }
    for (const type of responseTypes) {
      expect(isProxyToClientRelayControlType(type)).toBe(true);
      expect(isClientToProxyRelayControlType(type)).toBe(false);
    }
  });
});
