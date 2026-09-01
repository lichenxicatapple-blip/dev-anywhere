import { homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { ControlMessage } from "@dev-anywhere/shared";
import { RelayPreviewHandlers } from "#src/serve/preview/relay-preview-handlers.js";
import type { PreviewManager } from "#src/serve/preview/preview-manager.js";
import { RelayResourceHandlers } from "#src/serve/relay-resource-handlers.js";

describe("web preview relay handlers", () => {
  it("sends the create ACK before announcing starting state and reuses operationId", async () => {
    const order: string[] = [];
    const relaySend = vi.fn((raw: string) => {
      order.push(JSON.parse(raw).type as string);
    });
    const previewManager = {
      create: vi.fn(async () => ({ previewId: "preview-1" })),
      announce: vi.fn(() => order.push("announce")),
    } as unknown as PreviewManager;
    const handlers = new RelayPreviewHandlers({ relaySend, previewManager });

    await handlers.onCreate({
      type: "preview_create_request",
      requestId: "request-1",
      operationId: "operation-1",
      source: { kind: "local", url: "http://localhost:5173" },
      tunnelProvider: "cloudflare",
    });

    expect(previewManager.create).toHaveBeenCalledWith(
      "operation-1",
      {
        kind: "local",
        url: "http://localhost:5173",
      },
      "cloudflare",
    );
    expect(order).toEqual(["preview_create_response", "announce"]);
    expect(JSON.parse(relaySend.mock.calls[0]![0])).toEqual({
      type: "preview_create_response",
      requestId: "request-1",
      operationId: "operation-1",
      accepted: true,
      previewId: "preview-1",
    });
  });

  it("adds capability to proxy_info and forwards refreshPath without changing Agent detection", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const getWebPreviewCapability = vi.fn(async () => ({
      supported: true,
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
    const handlers = new RelayResourceHandlers({
      relaySend: (raw) => sent.push(JSON.parse(raw) as Record<string, unknown>),
      controlHandlers: {} as never,
      sessionManager: {} as never,
      getProviderEnv: () => ({ PATH: "" }),
      getAgentCliSuggestions: () => ({}),
      setAgentCliPath: vi.fn(),
      getWebPreviewCapability,
    });

    await handlers.onProxyInfoRequest({
      type: "proxy_info_request",
      requestId: "request-info",
      refreshPath: true,
    } as ControlMessage<"proxy_info_request">);

    expect(getWebPreviewCapability).toHaveBeenCalledWith(true);
    expect(sent[0]).toMatchObject({
      type: "proxy_info",
      requestId: "request-info",
      homePath: homedir() || "/",
      webPreview: {
        supported: true,
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
});
