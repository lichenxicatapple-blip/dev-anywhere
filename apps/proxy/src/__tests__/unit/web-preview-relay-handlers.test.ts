import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { ControlMessage } from "@dev-anywhere/shared";
import { RelayPreviewHandlers } from "#src/serve/preview/relay-preview-handlers.js";
import type { PreviewManager } from "#src/serve/preview/preview-manager.js";
import { PreviewOperationJournal } from "#src/serve/preview/preview-operation-journal.js";
import { RelayResourceHandlers } from "#src/serve/relay-resource-handlers.js";

const previewScope = { proxyId: "proxy-1", bindingId: "binding-1" } as const;

describe("web preview relay handlers", () => {
  it("ACKs a created preview without duplicating the manager's state event", async () => {
    const order: string[] = [];
    const relaySend = vi.fn((raw: string) => {
      order.push(JSON.parse(raw).type as string);
    });
    const previewManager = {
      create: vi.fn(async () => ({ previewId: "preview-1" })),
    } as unknown as PreviewManager;
    const operationJournal = new PreviewOperationJournal();
    const handlers = new RelayPreviewHandlers({
      relaySend,
      previewManager,
      operationJournal,
    });

    const request = {
      type: "preview_create_request",
      requestId: "request-1",
      scope: previewScope,
      operationId: "operation-1",
      source: { kind: "local", url: "http://localhost:5173" },
      tunnelProvider: "cloudflare",
      name: "Vite demo",
    } as const;
    await handlers.onCreate(request);
    await handlers.onCreate({ ...request, requestId: "request-2" });
    await handlers.onCreate({ ...request, requestId: "request-3", name: "Other demo" });

    expect(previewManager.create).toHaveBeenCalledWith(
      "operation-1",
      {
        kind: "local",
        url: "http://localhost:5173",
      },
      "cloudflare",
      "Vite demo",
    );
    expect(previewManager.create).toHaveBeenCalledOnce();
    expect(order).toEqual([
      "preview_create_response",
      "preview_create_response",
      "preview_create_response",
    ]);
    expect(JSON.parse(relaySend.mock.calls[0]![0])).toEqual({
      type: "preview_create_response",
      requestId: "request-1",
      scope: previewScope,
      operationId: "operation-1",
      accepted: true,
      previewId: "preview-1",
    });
    expect(JSON.parse(relaySend.mock.calls[1]![0])).toMatchObject({
      type: "preview_create_response",
      requestId: "request-2",
      accepted: true,
      previewId: "preview-1",
    });
    expect(JSON.parse(relaySend.mock.calls[2]![0])).toMatchObject({
      type: "preview_create_response",
      requestId: "request-3",
      accepted: false,
      errorCode: "OPERATION_CONFLICT",
    });
  });

  it("renames a preview without echoing authoritative entity state in the ACK", async () => {
    const relaySend = vi.fn();
    const previewManager = {
      rename: vi.fn(() => ({ previewId: "preview-1", name: "Product demo" })),
    } as unknown as PreviewManager;
    const handlers = new RelayPreviewHandlers({
      relaySend,
      previewManager,
      operationJournal: new PreviewOperationJournal(),
    });

    await handlers.onRename({
      type: "preview_rename_request",
      requestId: "rename-1",
      scope: previewScope,
      operationId: "rename-operation-1",
      previewId: "preview-1",
      name: "Product demo",
    });

    expect(previewManager.rename).toHaveBeenCalledWith("preview-1", "Product demo");
    expect(JSON.parse(relaySend.mock.calls[0]![0])).toEqual({
      type: "preview_rename_response",
      requestId: "rename-1",
      scope: previewScope,
      operationId: "rename-operation-1",
      previewId: "preview-1",
      success: true,
    });
  });

  it("echoes operationId for reconnect and close acknowledgements", async () => {
    const relaySend = vi.fn();
    const previewManager = {
      reconnect: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    } as unknown as PreviewManager;
    const handlers = new RelayPreviewHandlers({
      relaySend,
      previewManager,
      operationJournal: new PreviewOperationJournal(),
    });

    await handlers.onReconnect({
      type: "preview_reconnect_request",
      requestId: "reconnect-1",
      scope: previewScope,
      operationId: "reconnect-operation-1",
      previewId: "preview-1",
    });
    await handlers.onClose({
      type: "preview_close_request",
      requestId: "close-1",
      scope: previewScope,
      operationId: "close-operation-1",
      previewId: "preview-1",
    });

    expect(relaySend.mock.calls.map(([raw]) => JSON.parse(String(raw)))).toEqual([
      {
        type: "preview_reconnect_response",
        requestId: "reconnect-1",
        scope: previewScope,
        operationId: "reconnect-operation-1",
        previewId: "preview-1",
        success: true,
      },
      {
        type: "preview_close_response",
        requestId: "close-1",
        scope: previewScope,
        operationId: "close-operation-1",
        previewId: "preview-1",
        success: true,
      },
    ]);
  });

  it("reports Web preview capability through its scoped request", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const inspectCapabilities = vi.fn(async () => ({
      cloudflared: {
        available: true,
        command: "/usr/local/bin/cloudflared",
        version: "cloudflared version test",
      },
      cpolar: {
        available: true,
        command: "/opt/homebrew/bin/cpolar",
        version: "cpolar version test",
      },
    }));
    const handlers = new RelayPreviewHandlers({
      relaySend: (raw) => sent.push(JSON.parse(raw) as Record<string, unknown>),
      previewManager: { inspectCapabilities } as unknown as PreviewManager,
      operationJournal: new PreviewOperationJournal(),
    });

    await handlers.onCapability({
      type: "preview_capability_request",
      requestId: "request-capability",
      scope: previewScope,
      refreshPath: true,
    });

    expect(inspectCapabilities).toHaveBeenCalledWith(true);
    expect(sent[0]).toMatchObject({
      type: "preview_capability_response",
      requestId: "request-capability",
      scope: previewScope,
      success: true,
      capability: {
        cloudflared: {
          available: true,
          command: "/usr/local/bin/cloudflared",
        },
        cpolar: {
          available: true,
          command: "/opt/homebrew/bin/cpolar",
        },
      },
    });
  });

  it("reports strict Web capability failures", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const handlers = new RelayPreviewHandlers({
      relaySend: (raw) => sent.push(JSON.parse(raw) as Record<string, unknown>),
      previewManager: {
        inspectCapabilities: vi.fn(async () => {
          throw new Error("web detection failed");
        }),
      } as unknown as PreviewManager,
      operationJournal: new PreviewOperationJournal(),
    });

    await handlers.onCapability({
      type: "preview_capability_request",
      requestId: "request-capability",
      scope: previewScope,
      refreshPath: false,
    });

    expect(sent[0]).toEqual({
      type: "preview_capability_response",
      requestId: "request-capability",
      scope: previewScope,
      success: false,
      error: "web detection failed",
      errorCode: "UNKNOWN",
    });
  });

  it("returns only the public static inspection fields", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const inspectStatic = vi.fn(async () => ({
      rootPath: "/private/canonical/site",
      entryPath: "index.html",
      htmlEntries: ["index.html", "docs.html"],
    }));
    const handlers = new RelayPreviewHandlers({
      relaySend: (raw) => sent.push(JSON.parse(raw) as Record<string, unknown>),
      previewManager: { inspectStatic } as unknown as PreviewManager,
      operationJournal: new PreviewOperationJournal(),
    });

    await handlers.onStaticInspect({
      type: "preview_static_inspect_request",
      requestId: "inspect-static-1",
      scope: previewScope,
      path: "/selected/site",
    });

    expect(inspectStatic).toHaveBeenCalledWith("/selected/site");
    expect(sent[0]).toEqual({
      type: "preview_static_inspect_response",
      requestId: "inspect-static-1",
      scope: previewScope,
      success: true,
      entryPath: "index.html",
      htmlEntries: ["index.html", "docs.html"],
    });
    expect(sent[0]).not.toHaveProperty("rootPath");
  });

  it("keeps proxy_info limited to home and Agent CLI information", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const handlers = new RelayResourceHandlers({
      relaySend: (raw) => sent.push(JSON.parse(raw) as Record<string, unknown>),
      controlHandlers: {} as never,
      sessionManager: {} as never,
      getProviderEnv: () => ({ PATH: "" }),
      getAgentCliSuggestions: () => ({}),
      setAgentCliPath: vi.fn(),
    });

    await handlers.onProxyInfoRequest({
      type: "proxy_info_request",
      requestId: "request-info",
    } as ControlMessage<"proxy_info_request">);

    expect(sent[0]).toMatchObject({
      type: "proxy_info",
      requestId: "request-info",
      homePath: homedir() || "/",
      agentCli: expect.any(Object),
    });
    expect(sent[0]).not.toHaveProperty("webPreview");
    expect(sent[0]).not.toHaveProperty("devicePreview");
  });
});
