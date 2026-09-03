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
  WebPreviewTunnelStatusSchema,
} from "../web-preview.js";

const previewScope = { proxyId: "proxy-1", bindingId: "binding-1" } as const;

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
  it("models installed and unavailable tunnel tools as exclusive states", () => {
    const ready = {
      available: true,
      command: "/usr/local/bin/cloudflared",
      version: "2026.8.1",
    } as const;
    const unavailable = {
      available: false,
      error: "Cloudflare Tunnel not found",
      suggestions: ["/opt/homebrew/bin/cloudflared"],
    } as const;
    expect(WebPreviewTunnelStatusSchema.parse(ready)).toEqual(ready);
    expect(WebPreviewTunnelStatusSchema.parse(unavailable)).toEqual(unavailable);

    for (const status of [
      { available: true },
      { available: true, command: "cloudflared", error: "mixed state" },
      { available: false },
      { available: false, command: "cloudflared", error: "not runnable" },
      { available: false, version: "2026.8.1", error: "not runnable" },
      { ...ready, extra: true },
    ]) {
      expect(WebPreviewTunnelStatusSchema.safeParse(status).success).toBe(false);
    }
  });

  it("reports both tunnel executables", () => {
    expect(
      WebPreviewCapabilitySchema.parse({
        cloudflared: { available: true, command: "/usr/local/bin/cloudflared" },
        cpolar: { available: true, command: "/usr/local/bin/cpolar", version: "3.3.18" },
      }),
    ).toMatchObject({
      cloudflared: { available: true },
      cpolar: { available: true, command: "/usr/local/bin/cpolar" },
    });
  });

  it("rejects the removed top-level preview support flag", () => {
    expect(
      WebPreviewCapabilitySchema.safeParse({
        supported: true,
        cloudflared: { available: true, command: "cloudflared" },
        cpolar: { available: false, error: "not found" },
      }).success,
    ).toBe(false);
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
          scope: previewScope,
          operationId: "create-op-invalid-local-url",
          tunnelProvider: "cloudflare",
          source: { kind: "local", url },
        }),
      ).not.toThrow();
      expect(
        RelayControlSchema.safeParse({
          type: "preview_create_request",
          requestId: "create-invalid-local-url",
          scope: previewScope,
          operationId: "create-op-invalid-local-url",
          tunnelProvider: "cloudflare",
          source: { kind: "local", url },
        }).success,
      ).toBe(false);
    },
  );

  it("requires an explicit entry for static creation and accepts normalized summaries", () => {
    expect(
      WebPreviewSourceInputSchema.parse({
        kind: "static",
        path: "./output",
        entryPath: "pages/home.html",
      }),
    ).toEqual({ kind: "static", path: "./output", entryPath: "pages/home.html" });
    expect(
      WebPreviewSourceInputSchema.safeParse({ kind: "static", path: "./output" }).success,
    ).toBe(false);

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

  it("binds URLs and errors to the only states that can carry them", () => {
    const common = {
      previewId: readyPreview.previewId,
      name: readyPreview.name,
      source: readyPreview.source,
      tunnelProvider: readyPreview.tunnelProvider,
      createdAt: readyPreview.createdAt,
      updatedAt: readyPreview.updatedAt,
    } as const;

    for (const state of ["starting", "disconnected", "stopping"] as const) {
      expect(PreviewSummarySchema.safeParse({ ...common, state }).success).toBe(true);
    }
    expect(
      PreviewSummarySchema.safeParse({ ...common, state: "failed", error: "tunnel stopped" })
        .success,
    ).toBe(true);

    for (const preview of [
      { ...common, state: "ready" },
      { ...readyPreview, error: "mixed state" },
      { ...common, state: "failed" },
      { ...common, state: "failed", error: "failed", publicUrl: readyPreview.publicUrl },
      { ...common, state: "disconnected", error: "mixed state" },
      { ...common, state: "starting", publicUrl: readyPreview.publicUrl },
    ]) {
      expect(PreviewSummarySchema.safeParse(preview).success).toBe(false);
    }
  });

  it("rejects unknown fields in source inputs and summaries", () => {
    expect(
      WebPreviewSourceInputSchema.safeParse({
        kind: "local",
        url: "http://localhost:5173",
        extra: true,
      }).success,
    ).toBe(false);
    expect(PreviewSummarySchema.safeParse({ ...readyPreview, extra: true }).success).toBe(false);
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
          scope: previewScope,
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
      scope: previewScope,
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
          scope: previewScope,
          epoch: "proxy-epoch-invalid-url",
          revision: 11,
          preview,
        }).success,
      ).toBe(false);
    }
  });
});

describe("web preview relay controls", () => {
  it("requires one Preview scope on every request", () => {
    const requests = [
      {
        type: "preview_capability_request",
        requestId: "capability-1",
        refreshPath: false,
      },
      { type: "preview_static_inspect_request", requestId: "inspect-1", path: "./dist" },
      {
        type: "preview_create_request",
        requestId: "create-1",
        operationId: "operation-1",
        source: { kind: "local", url: "http://localhost:5173" },
        tunnelProvider: "cloudflare",
      },
      { type: "preview_list_request", requestId: "list-1" },
      {
        type: "preview_rename_request",
        requestId: "rename-1",
        operationId: "rename-operation-1",
        previewId: "preview-1",
        name: "Checkout",
      },
      {
        type: "preview_reconnect_request",
        requestId: "reconnect-1",
        operationId: "reconnect-operation-1",
        previewId: "preview-1",
      },
      {
        type: "preview_close_request",
        requestId: "close-1",
        operationId: "close-operation-1",
        previewId: "preview-1",
      },
    ] as const;

    for (const request of requests) {
      expect(RelayControlSchema.safeParse(request).success).toBe(false);
      expect(RelayControlSchema.parse({ ...request, scope: previewScope })).toEqual({
        ...request,
        scope: previewScope,
      });
    }
  });

  it("requires operationId on every rename, reconnect, and close request and response", () => {
    const messagesWithoutOperation = [
      {
        type: "preview_rename_request",
        requestId: "rename-1",
        scope: previewScope,
        previewId: "preview-1",
        name: "Checkout",
      },
      {
        type: "preview_rename_response",
        requestId: "rename-1",
        previewId: "preview-1",
        success: true,
      },
      {
        type: "preview_reconnect_request",
        requestId: "reconnect-1",
        scope: previewScope,
        previewId: "preview-1",
      },
      {
        type: "preview_reconnect_response",
        requestId: "reconnect-1",
        previewId: "preview-1",
        success: true,
      },
      {
        type: "preview_close_request",
        requestId: "close-1",
        scope: previewScope,
        previewId: "preview-1",
      },
      {
        type: "preview_close_response",
        requestId: "close-1",
        previewId: "preview-1",
        success: true,
      },
    ] as const;

    for (const message of messagesWithoutOperation) {
      expect(RelayControlSchema.safeParse(message).success).toBe(false);
    }
  });

  it("parses scoped capability requests and strict success responses", () => {
    expect(
      RelayControlSchema.parse({
        type: "preview_capability_request",
        requestId: "capability-refresh",
        scope: previewScope,
        refreshPath: true,
      }),
    ).toEqual({
      type: "preview_capability_request",
      requestId: "capability-refresh",
      scope: previewScope,
      refreshPath: true,
    });

    expect(
      RelayControlSchema.parse({
        type: "preview_capability_response",
        requestId: "capability-refresh",
        scope: previewScope,
        success: true,
        capability: {
          cloudflared: {
            available: true,
            command: "/opt/homebrew/bin/cloudflared",
            version: "2026.8.1",
          },
          cpolar: { available: false, error: "cpolar not found" },
        },
      }),
    ).toMatchObject({ success: true, capability: { cloudflared: { available: true } } });

    expect(
      RelayControlSchema.parse({
        type: "preview_capability_response",
        requestId: "capability-failed",
        scope: previewScope,
        success: false,
        error: "detection failed",
        errorCode: "UNKNOWN",
      }),
    ).toMatchObject({ success: false, error: "detection failed" });

    for (const invalid of [
      {
        type: "preview_capability_request",
        requestId: "missing-refresh",
        scope: previewScope,
      },
      {
        type: "preview_capability_response",
        requestId: "missing-capability",
        success: true,
      },
      {
        type: "preview_capability_response",
        requestId: "missing-error",
        success: false,
      },
      {
        type: "preview_capability_response",
        requestId: "illegal-mixed-state",
        success: false,
        error: "failed",
        capability: {
          cloudflared: { available: true, command: "cloudflared" },
          cpolar: { available: false, error: "not found" },
        },
      },
    ]) {
      expect(RelayControlSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("parses inspect, create, list, reconnect, close and push messages", () => {
    const messages = [
      {
        type: "preview_static_inspect_request",
        requestId: "inspect-1",
        scope: previewScope,
        path: "./output",
      },
      {
        type: "preview_static_inspect_response",
        requestId: "inspect-1",
        scope: previewScope,
        success: true,
        htmlEntries: ["home.html", "pages/about.html"],
      },
      {
        type: "preview_create_request",
        requestId: "create-1",
        scope: previewScope,
        operationId: "create-op-1",
        source: { kind: "static", path: "./output", entryPath: "home.html" },
        tunnelProvider: "cpolar",
        name: "Project docs",
      },
      {
        type: "preview_create_response",
        requestId: "create-1",
        scope: previewScope,
        operationId: "create-op-1",
        accepted: true,
        previewId: "preview-1",
      },
      { type: "preview_list_request", requestId: "list-1", scope: previewScope },
      {
        type: "preview_list_response",
        requestId: "list-1",
        scope: previewScope,
        epoch: "proxy-epoch-1",
        revision: 3,
        previews: [readyPreview],
      },
      {
        type: "preview_rename_request",
        requestId: "rename-1",
        scope: previewScope,
        operationId: "rename-operation-1",
        previewId: "preview-1",
        name: "Project docs",
      },
      {
        type: "preview_rename_response",
        requestId: "rename-1",
        scope: previewScope,
        operationId: "rename-operation-1",
        previewId: "preview-1",
        success: true,
      },
      {
        type: "preview_reconnect_request",
        requestId: "reconnect-1",
        scope: previewScope,
        operationId: "reconnect-operation-1",
        previewId: "preview-1",
      },
      {
        type: "preview_reconnect_response",
        requestId: "reconnect-1",
        scope: previewScope,
        operationId: "reconnect-operation-1",
        previewId: "preview-1",
        success: true,
      },
      {
        type: "preview_close_request",
        requestId: "close-1",
        scope: previewScope,
        operationId: "close-operation-1",
        previewId: "preview-1",
      },
      {
        type: "preview_close_response",
        requestId: "close-1",
        scope: previewScope,
        operationId: "close-operation-1",
        previewId: "preview-1",
        success: true,
      },
      {
        type: "preview_state_push",
        scope: previewScope,
        epoch: "proxy-epoch-1",
        revision: 4,
        preview: readyPreview,
      },
      {
        type: "preview_removed_push",
        scope: previewScope,
        epoch: "proxy-epoch-1",
        revision: 5,
        previewId: "preview-1",
      },
    ];

    for (const message of messages) expect(RelayControlSchema.parse(message)).toEqual(message);
  });

  it("trims custom names and rejects blank or oversized names", () => {
    expect(
      RelayControlSchema.parse({
        type: "preview_create_request",
        requestId: "create-name-1",
        scope: previewScope,
        operationId: "create-name-operation-1",
        source: { kind: "local", url: "http://localhost:5173" },
        tunnelProvider: "cloudflare",
        name: "  Project docs  ",
      }),
    ).toMatchObject({ name: "Project docs" });
    expect(
      RelayControlSchema.parse({
        type: "preview_rename_request",
        requestId: "rename-name-1",
        scope: previewScope,
        operationId: "rename-name-operation-1",
        previewId: "preview-1",
        name: "  Project docs  ",
      }),
    ).toMatchObject({ name: "Project docs" });
    expect(PreviewSummarySchema.parse({ ...readyPreview, name: "  Project docs  " })).toMatchObject(
      {
        name: "Project docs",
      },
    );

    for (const name of ["   ", "x".repeat(257)]) {
      expect(
        RelayControlSchema.safeParse({
          type: "preview_create_request",
          requestId: "create-invalid-name",
          scope: previewScope,
          operationId: "create-invalid-name-operation",
          source: { kind: "local", url: "http://localhost:5173" },
          tunnelProvider: "cloudflare",
          name,
        }).success,
      ).toBe(false);
      expect(
        RelayControlSchema.safeParse({
          type: "preview_rename_request",
          requestId: "rename-invalid-name",
          scope: previewScope,
          operationId: "rename-invalid-name-operation",
          previewId: "preview-1",
          name,
        }).success,
      ).toBe(false);
    }
  });

  it("requires a tunnel provider on create requests and summaries", () => {
    const createRequestWithoutProvider = {
      type: "preview_create_request",
      requestId: "create-without-provider",
      scope: previewScope,
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
      scope: previewScope,
      operationId: "create-op-1",
      source: { kind: "local", url: "http://localhost:5173" },
    };
    const responseWithoutId = {
      type: "preview_close_response",
      operationId: "close-operation-1",
      previewId: "preview-1",
      success: true,
    };

    expect(() => RelayControlSchema.parse(requestWithoutId)).toThrow();
    expect(() => RelayControlSchema.parse(responseWithoutId)).toThrow();
  });

  it("marks all requests client-to-proxy and all responses/pushes proxy-to-client", () => {
    const requestTypes = [
      "preview_capability_request",
      "preview_static_inspect_request",
      "preview_create_request",
      "preview_list_request",
      "preview_rename_request",
      "preview_reconnect_request",
      "preview_close_request",
    ] as const;
    const responseTypes = [
      "preview_capability_response",
      "preview_static_inspect_response",
      "preview_create_response",
      "preview_list_response",
      "preview_rename_response",
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

    for (const type of ["preview_state_event", "preview_removed_event"] as const) {
      expect(isProxyToClientRelayControlType(type)).toBe(false);
      expect(isClientToProxyRelayControlType(type)).toBe(false);
    }
  });

  it("separates Proxy events from Relay-scoped browser pushes", () => {
    const event = {
      type: "preview_state_event",
      epoch: "proxy-epoch-1",
      revision: 4,
      preview: readyPreview,
    } as const;
    expect(RelayControlSchema.parse(event)).toEqual(event);
    expect(RelayControlSchema.safeParse({ ...event, type: "preview_state_push" }).success).toBe(
      false,
    );
  });

  it("enforces mutually exclusive strict Web Preview response states", () => {
    const staticBase = {
      type: "preview_static_inspect_response",
      requestId: "inspect-1",
      scope: previewScope,
    } as const;
    const mutationBase = {
      requestId: "mutation-1",
      scope: previewScope,
      operationId: "operation-1",
      previewId: "preview-1",
    } as const;
    const valid = [
      {
        ...staticBase,
        success: true,
        htmlEntries: ["index.html"],
      },
      { ...staticBase, success: false, error: "not found", errorCode: "PATH_NOT_FOUND" },
      { type: "preview_rename_response", ...mutationBase, success: true },
      {
        type: "preview_rename_response",
        ...mutationBase,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
      },
      { type: "preview_reconnect_response", ...mutationBase, success: true },
      {
        type: "preview_reconnect_response",
        ...mutationBase,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
      },
      { type: "preview_close_response", ...mutationBase, success: true },
      {
        type: "preview_close_response",
        ...mutationBase,
        success: false,
        error: "failed",
        errorCode: "UNKNOWN",
      },
    ] as const;
    for (const message of valid) expect(RelayControlSchema.safeParse(message).success).toBe(true);

    const invalid = [
      { ...staticBase, success: true, rootPath: "/project/output", htmlEntries: [] },
      {
        ...staticBase,
        success: true,
        htmlEntries: [],
        error: "mixed",
      },
      {
        ...staticBase,
        success: false,
        error: "",
        errorCode: "UNKNOWN",
        rootPath: "/project/output",
      },
      { ...staticBase, success: false, error: "not found" },
      { type: "preview_rename_response", ...mutationBase, success: true, name: "legacy echo" },
      {
        type: "preview_rename_response",
        ...mutationBase,
        success: false,
        error: "",
        errorCode: "UNKNOWN",
        name: "old",
      },
      {
        type: "preview_rename_response",
        ...mutationBase,
        success: false,
        error: "failed",
      },
      { type: "preview_reconnect_response", ...mutationBase, success: false },
      {
        type: "preview_close_response",
        ...mutationBase,
        success: true,
        error: "mixed",
      },
    ] as const;
    for (const message of invalid)
      expect(RelayControlSchema.safeParse(message).success).toBe(false);
  });

  it("rejects unknown top-level fields on scoped Web Preview protocol objects", () => {
    const messages = [
      {
        type: "preview_list_request",
        requestId: "list-1",
        scope: previewScope,
      },
      {
        type: "preview_list_response",
        requestId: "list-1",
        scope: previewScope,
        epoch: "epoch-1",
        revision: 0,
        previews: [],
      },
      {
        type: "preview_state_event",
        epoch: "epoch-1",
        revision: 1,
        preview: readyPreview,
      },
      {
        type: "preview_state_push",
        scope: previewScope,
        epoch: "epoch-1",
        revision: 1,
        preview: readyPreview,
      },
    ] as const;
    for (const message of messages) {
      expect(RelayControlSchema.safeParse({ ...message, legacy: true }).success).toBe(false);
    }
  });

  it("rejects illegal Web Preview create ACK states", () => {
    const base = {
      type: "preview_create_response",
      requestId: "create-1",
      scope: previewScope,
      operationId: "operation-1",
    } as const;
    for (const message of [
      { ...base, accepted: true },
      {
        ...base,
        accepted: false,
        error: "failed",
        errorCode: "UNKNOWN",
        previewId: "preview-1",
      },
      { ...base, accepted: false },
      { ...base, accepted: false, error: "failed" },
    ]) {
      expect(RelayControlSchema.safeParse(message).success).toBe(false);
    }
    expect(
      RelayControlSchema.safeParse({
        ...base,
        accepted: false,
        error: "failed",
        errorCode: "UNKNOWN",
      }).success,
    ).toBe(true);
  });
});
