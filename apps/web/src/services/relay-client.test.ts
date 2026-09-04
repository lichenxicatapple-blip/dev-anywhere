import { afterEach, describe, expect, it, vi } from "vitest";
import type { PreviewScope } from "@dev-anywhere/shared";
import { RelayClient } from "./relay-client";

class FakeWebSocketManager {
  sent: string[] = [];
  connected = true;
  private messageHandlers = new Set<(data: string) => void>();
  private statusHandlers = new Set<(connected: boolean) => void>();

  send(data: string): boolean {
    this.sent.push(data);
    return this.connected;
  }

  onMessage(handler: (data: string) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: (connected: boolean) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  emit(payload: unknown): void {
    const data = JSON.stringify(payload);
    this.messageHandlers.forEach((handler) => handler(data));
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.statusHandlers.forEach((handler) => handler(connected));
  }
}

function sentRequestId(ws: FakeWebSocketManager, index = 0): string {
  const msg = JSON.parse(ws.sent[index] ?? "{}") as { requestId?: string };
  if (!msg.requestId) throw new Error(`missing requestId in sent message ${index}`);
  return msg.requestId;
}

function createClient(): { relay: RelayClient; ws: FakeWebSocketManager } {
  const ws = new FakeWebSocketManager();
  return {
    relay: new RelayClient(ws, "client-1"),
    ws,
  };
}

function restorePreviewScope(
  relay: RelayClient,
  ws: FakeWebSocketManager,
  proxyId = "proxy-a",
  bindingId = "binding-a-1",
): PreviewScope {
  ws.emit({
    type: "client_register_response",
    status: "restored",
    proxyId,
    bindingId,
  });
  const scope = relay.getPreviewScope();
  if (!scope) throw new Error("expected restored preview scope");
  return scope;
}

describe("RelayClient request handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers a device descriptor for client management", () => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 5,
    });
    const { relay, ws } = createClient();

    relay.register();

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "client_register",
      clientId: "client-1",
      platform: "MacIntel",
      maxTouchPoints: 5,
      browserName: "Safari",
      osName: "iPad",
      deviceKind: "tablet",
    });
  });

  it("preserves an envelope when its type also exists in the control protocol", () => {
    const { relay, ws } = createClient();
    const handler = vi.fn();
    relay.onMessage(handler);

    ws.emit({
      type: "session_list",
      seq: 0,
      timestamp: 1,
      source: "proxy",
      version: "1.0",
      payload: { sessions: [] },
    });

    expect(handler).toHaveBeenCalledWith({
      type: "session_list",
      seq: 0,
      timestamp: 1,
      source: "proxy",
      version: "1.0",
      payload: { sessions: [] },
    });
  });

  it("drops an old unscoped preview push before it can be buffered or dispatched", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { relay, ws } = createClient();

      ws.emit({
        type: "preview_state_push",
        epoch: "preview-epoch",
        revision: 1,
        preview: {
          previewId: "preview-one",
          name: "Docs",
          source: { kind: "local", url: "http://localhost:5173" },
          state: "starting",
          tunnelProvider: "cloudflare",
          createdAt: 1,
          updatedAt: 1,
        },
      });

      const handler = vi.fn();
      relay.onMessage(handler);

      expect(handler).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "RelayClient: malformed inbound message dropped",
        expect.objectContaining({ type: "preview_state_push" }),
      );
      expect(JSON.stringify(warn.mock.calls[0]).length).toBeLessThan(1_000);
    } finally {
      warn.mockRestore();
    }
  });

  it("does not resolve a pending request from a malformed success payload", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { relay, ws } = createClient();
      const scope = restorePreviewScope(relay, ws);
      const operationId = "malformed-create-operation";
      const promise = relay.createWebPreview(
        scope,
        { kind: "local", url: "http://localhost:5173" },
        { tunnelProvider: "cloudflare", operationId, timeoutMs: 100 },
      );
      const assertion = expect(promise).rejects.toThrow("创建网页预览超时");
      const requestId = sentRequestId(ws);

      ws.emit({
        type: "preview_create_response",
        requestId,
        scope,
        operationId,
        accepted: true,
      });

      expect(warn).toHaveBeenCalledWith(
        "RelayClient: malformed inbound message dropped",
        expect.objectContaining({ type: "preview_create_response" }),
      );
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("resolves proxy list requests from the matching response", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestProxyList();
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "proxy_list_response",
      requestId,
      proxies: [{ proxyId: "proxy-1", online: true, sessions: ["s1"] }],
    });

    await expect(promise).resolves.toEqual([
      { proxyId: "proxy-1", online: true, sessions: ["s1"] },
    ]);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({ type: "proxy_list_request" });
  });

  it("removes an offline proxy with a request-scoped response", async () => {
    const { relay, ws } = createClient();
    const promise = relay.removeOfflineProxy("proxy-offline");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "proxy_remove_response",
      requestId: "another-request",
      proxyId: "proxy-offline",
      success: true,
    });
    ws.emit({
      type: "proxy_remove_response",
      requestId,
      proxyId: "proxy-offline",
      success: true,
    });

    await expect(promise).resolves.toEqual({
      proxyId: "proxy-offline",
      success: true,
      error: undefined,
      errorCode: undefined,
    });
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "proxy_remove",
      requestId,
      proxyId: "proxy-offline",
    });
  });

  it("returns the Relay rejection when a proxy came back online before removal", async () => {
    const { relay, ws } = createClient();
    const promise = relay.removeOfflineProxy("proxy-1");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "proxy_remove_response",
      requestId,
      proxyId: "proxy-1",
      success: false,
      errorCode: "PROXY_ONLINE",
      error: "开发机 proxy-1 仍在线，无法删除",
    });

    await expect(promise).resolves.toMatchObject({
      proxyId: "proxy-1",
      success: false,
      errorCode: "PROXY_ONLINE",
    });
  });

  it("times out an unanswered offline proxy removal", async () => {
    vi.useFakeTimers();
    try {
      const { relay } = createClient();
      const promise = relay.removeOfflineProxy("proxy-1", 100);
      const assertion = expect(promise).rejects.toThrow("移除开发机超时");

      await vi.advanceTimersByTimeAsync(100);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves relay client list requests from the matching response", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestRelayClients();
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "relay_client_list_response",
      requestId,
      clients: [
        {
          clientId: "client-1",
          connectedAt: 1760000000000,
          current: true,
          browserName: "Safari",
          osName: "macOS",
          deviceKind: "desktop",
        },
      ],
    });

    await expect(promise).resolves.toEqual([
      {
        clientId: "client-1",
        connectedAt: 1760000000000,
        current: true,
        browserName: "Safari",
        osName: "macOS",
        deviceKind: "desktop",
      },
    ]);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "relay_client_list_request",
    });
  });

  it("sends relay client kick requests and returns the relay result", async () => {
    const { relay, ws } = createClient();
    const promise = relay.kickRelayClient("client-2");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "relay_client_kick_response",
      requestId,
      clientId: "client-2",
      success: true,
    });

    await expect(promise).resolves.toEqual({
      clientId: "client-2",
      success: true,
      error: undefined,
      errorCode: undefined,
    });
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "relay_client_kick",
      clientId: "client-2",
    });
  });

  it("times out unanswered requests instead of leaving the UI pending forever", async () => {
    vi.useFakeTimers();
    try {
      const { relay } = createClient();
      const promise = relay.requestProxyList(100);
      const assertion = expect(promise).rejects.toThrow("请求开发机列表超时");

      await vi.advanceTimersByTimeAsync(100);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects immediately when a request cannot be sent on a disconnected socket", async () => {
    const { relay, ws } = createClient();
    ws.connected = false;

    await expect(relay.selectProxy("proxy-1")).rejects.toThrow("连接已断开");
  });

  it("waits for the matching directory create response", async () => {
    const { relay, ws } = createClient();
    const promise = relay.createDirectory("/home/dev/new-project");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "dir_create_response",
      requestId: "other-request",
      path: "/home/dev/new-project",
      success: true,
    });
    ws.emit({
      type: "dir_create_response",
      requestId,
      path: "/home/dev/new-project",
      success: true,
    });

    await expect(promise).resolves.toEqual({
      path: "/home/dev/new-project",
      success: true,
      error: undefined,
      errorCode: undefined,
    });
  });

  it("waits for the matching directory list response", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestDirectoryList("/home/dev", { includeHidden: true });
    const requestId = sentRequestId(ws);
    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "dir_list_request",
      path: "/home/dev",
      includeHidden: true,
    });

    ws.emit({
      type: "dir_list_response",
      requestId: "other-request",
      path: "/home/dev",
      includeHidden: true,
      entries: [{ name: "wrong", isDir: true }],
    });
    ws.emit({
      type: "dir_list_response",
      requestId,
      path: "/home/dev",
      includeHidden: true,
      entries: [{ name: "workspace", isDir: true }],
    });

    await expect(promise).resolves.toEqual({
      path: "/home/dev",
      includeHidden: true,
      entries: [{ name: "workspace", isDir: true }],
      error: undefined,
      errorCode: undefined,
    });
  });

  it("sends the normal-tree policy explicitly when hidden entries are not requested", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestDirectoryList("/home/dev");
    const requestId = sentRequestId(ws);

    expect(JSON.parse(ws.sent.at(-1) ?? "{}")).toMatchObject({
      type: "dir_list_request",
      path: "/home/dev",
      includeHidden: false,
    });
    ws.emit({
      type: "dir_list_response",
      requestId,
      path: "/home/dev",
      includeHidden: false,
      entries: [{ name: "workspace", isDir: true }],
    });

    await expect(promise).resolves.toMatchObject({
      path: "/home/dev",
      includeHidden: false,
      entries: [{ name: "workspace", isDir: true }],
    });
  });

  it("uploads clipboard images through a remote upload URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessionId: "s1",
        success: true,
        path: ".dev-anywhere/clipboard/s1/shot.png",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { relay, ws } = createClient();
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    const promise = relay.uploadClipboardImage("s1", file);
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "remote_file_upload_url_response",
      requestId: "other-request",
      sessionId: "s1",
      success: true,
      uploadUrl: "/api/remote-uploads/wrong",
    });
    ws.emit({
      type: "remote_file_upload_url_response",
      requestId,
      sessionId: "other-session",
      success: true,
      uploadUrl: "/api/remote-uploads/wrong-session",
    });
    ws.emit({
      type: "remote_file_upload_url_response",
      requestId,
      sessionId: "s1",
      success: true,
      uploadUrl: "/api/remote-uploads/token-1",
      expiresAt: 123,
    });

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "remote_file_upload_url_request",
      requestId,
      sessionId: "s1",
      kind: "clipboard_image",
      mimeType: "image/png",
      fileName: "shot.png",
      size: 3,
    });
    await expect(promise).resolves.toEqual({
      sessionId: "s1",
      success: true,
      path: ".dev-anywhere/clipboard/s1/shot.png",
      error: undefined,
      errorCode: undefined,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/remote-uploads/token-1", {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: file,
    });
  });

  it("returns upload URL failures without issuing an HTTP upload", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { relay, ws } = createClient();
    const file = new File([new Uint8Array([1])], "large.png", { type: "image/png" });
    const promise = relay.uploadFile("s1", file);
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "remote_file_upload_url_response",
      requestId,
      sessionId: "s1",
      success: false,
      error: "当前未连接开发机",
    });

    await expect(promise).resolves.toEqual({
      sessionId: "s1",
      success: false,
      error: "当前未连接开发机",
      errorCode: undefined,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for matching session rename responses", async () => {
    const { relay, ws } = createClient();
    const promise = relay.renameSession("s1", "Release checklist");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "session_rename_response",
      requestId: "other-request",
      sessionId: "s1",
      success: true,
      name: "wrong",
    });
    ws.emit({
      type: "session_rename_response",
      requestId,
      sessionId: "other-session",
      success: true,
      name: "wrong-session",
    });
    ws.emit({
      type: "session_rename_response",
      requestId,
      sessionId: "s1",
      success: true,
      name: "Release checklist",
    });

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "session_rename",
      requestId,
      sessionId: "s1",
      name: "Release checklist",
    });
    await expect(promise).resolves.toEqual({
      sessionId: "s1",
      success: true,
      name: "Release checklist",
      error: undefined,
      errorCode: undefined,
    });
  });

  it("waits for matching remote file URL responses", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestRemoteFileUrl("s1", "build/out.tar.gz", "download");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "remote_file_url_response",
      requestId: "other-request",
      sessionId: "s1",
      success: true,
      url: "/api/remote-files/wrong",
    });
    ws.emit({
      type: "remote_file_url_response",
      requestId,
      sessionId: "other-session",
      success: true,
      url: "/api/remote-files/wrong-session",
    });
    ws.emit({
      type: "remote_file_url_response",
      requestId,
      sessionId: "s1",
      path: "build/out.tar.gz",
      success: true,
      url: "/api/remote-files/token-1",
      expiresAt: 123,
    });

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "remote_file_url_request",
      requestId,
      sessionId: "s1",
      path: "build/out.tar.gz",
      disposition: "download",
    });
    await expect(promise).resolves.toEqual({
      sessionId: "s1",
      success: true,
      path: "build/out.tar.gz",
      url: "/api/remote-files/token-1",
      expiresAt: 123,
      error: undefined,
      errorCode: undefined,
    });
  });

  it("waits for matching proxy info responses", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestProxyInfo();
    const requestId = sentRequestId(ws);
    const agentCli = {
      claude: { available: true, command: "/usr/local/bin/claude" },
      codex: { available: false, error: "codex not found" },
    };

    ws.emit({
      type: "proxy_info",
      requestId: "other-request",
      homePath: "/tmp",
      agentCli,
    });
    ws.emit({
      type: "proxy_info",
      requestId,
      homePath: "/home/dev",
      agentCli,
    });

    await expect(promise).resolves.toEqual({
      homePath: "/home/dev",
      agentCli,
    });
  });

  it("updates an Agent CLI path through the selected proxy", async () => {
    const { relay, ws } = createClient();
    const promise = relay.updateAgentCliPath("claude", "/home/dev/.local/bin/claude");
    const requestId = sentRequestId(ws);
    const agentCli = {
      claude: { available: true, command: "/home/dev/.local/bin/claude" },
      codex: { available: true, command: "/usr/local/bin/codex" },
    };

    ws.emit({
      type: "agent_cli_config_update_response",
      requestId,
      provider: "claude",
      agentCli,
    });

    await expect(promise).resolves.toEqual({ provider: "claude", agentCli });
  });

  it("updates the Kimi CLI path through the selected proxy", async () => {
    const { relay, ws } = createClient();
    const promise = relay.updateAgentCliPath("kimi", "/home/dev/.local/bin/kimi");
    const requestId = sentRequestId(ws);
    const agentCli = {
      claude: { available: true, command: "/usr/local/bin/claude" },
      codex: { available: true, command: "/usr/local/bin/codex" },
      kimi: { available: true, command: "/home/dev/.local/bin/kimi" },
    };

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "agent_cli_config_update",
      provider: "kimi",
      path: "/home/dev/.local/bin/kimi",
    });

    ws.emit({
      type: "agent_cli_config_update_response",
      requestId,
      provider: "kimi",
      agentCli,
    });

    await expect(promise).resolves.toEqual({ provider: "kimi", agentCli });
  });

  it("reads the relay-local Voice Pilot config", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestVoiceConfig();
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "voice_config_response",
      requestId: "other-request",
      config: {
        provider: "aliyun-bailian",
        configured: false,
        region: "intl",
        asrModel: "wrong-asr",
        ttsModel: "wrong-tts",
        ttsVoice: "wrong-voice",
        turnIdleSeconds: 4,
      },
    });
    ws.emit({
      type: "voice_config_response",
      requestId,
      config: {
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
        turnIdleSeconds: 5,
      },
    });

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "voice_config_request",
      requestId,
    });
    await expect(promise).resolves.toEqual({
      config: {
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
        turnIdleSeconds: 5,
      },
      error: undefined,
      errorCode: undefined,
    });
  });

  it("updates the relay-local Voice Pilot config without expecting the api key back", async () => {
    const { relay, ws } = createClient();
    const promise = relay.updateVoiceConfig({
      apiKey: "sk-secret",
      region: "cn",
      asrModel: "qwen3-asr-flash-realtime",
      ttsModel: "cosyvoice-v3-flash",
      ttsVoice: "longwan",
      turnIdleSeconds: 5,
    });
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "voice_config_update_response",
      requestId,
      success: true,
      config: {
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longwan",
        turnIdleSeconds: 5,
      },
    });

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "voice_config_update",
      requestId,
      config: {
        apiKey: "sk-secret",
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longwan",
        turnIdleSeconds: 5,
      },
    });
    await expect(promise).resolves.toEqual({
      success: true,
      config: {
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longwan",
        turnIdleSeconds: 5,
      },
      error: undefined,
      errorCode: undefined,
    });
  });

  it("reads dynamic Voice Pilot capabilities from relay", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestVoiceCapabilities({ region: "cn" });
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "voice_capabilities_response",
      requestId,
      capabilities: {
        asrModels: [{ value: "asr-dynamic", label: "Dynamic ASR", source: "official" }],
        ttsModels: [{ value: "tts-dynamic", label: "Dynamic TTS", source: "official" }],
        ttsVoices: [
          {
            value: "voice-dynamic",
            label: "动态音色 · 女",
            gender: "female",
            model: "tts-dynamic",
            source: "official",
          },
        ],
        fetchedAt: 1760000000000,
      },
    });

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "voice_capabilities_request",
      requestId,
      region: "cn",
    });
    await expect(promise).resolves.toEqual({
      capabilities: {
        asrModels: [{ value: "asr-dynamic", label: "Dynamic ASR", source: "official" }],
        ttsModels: [{ value: "tts-dynamic", label: "Dynamic TTS", source: "official" }],
        ttsVoices: [
          {
            value: "voice-dynamic",
            label: "动态音色 · 女",
            gender: "female",
            model: "tts-dynamic",
            source: "official",
          },
        ],
        fetchedAt: 1760000000000,
      },
      error: undefined,
      errorCode: undefined,
    });
  });

  it("tests the relay-local Voice Pilot config with unsaved form values", async () => {
    const { relay, ws } = createClient();
    const promise = relay.testVoiceConfig({
      apiKey: "sk-secret",
      region: "cn",
      asrModel: "qwen3-asr-flash-realtime",
      ttsModel: "cosyvoice-v3-flash",
      ttsVoice: "longanyang",
    });
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "voice_config_test_response",
      requestId,
      success: true,
      audioBase64: "AQI=",
      audioSampleRate: 16000,
      audioEncoding: "pcm_s16le",
      transcript: "语音助手测试",
    });

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "voice_config_test",
      requestId,
      config: {
        apiKey: "sk-secret",
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
      },
    });
    await expect(promise).resolves.toEqual({
      success: true,
      audioBase64: "AQI=",
      audioSampleRate: 16000,
      audioEncoding: "pcm_s16le",
      transcript: "语音助手测试",
      error: undefined,
      errorCode: undefined,
    });
  });

  it("requests Voice Pilot summaries from the selected proxy", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestVoiceSummary("s1", "msg-1", "```ts\nconst x = 1;\n```", "code");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "voice_summary_response",
      requestId: "other-request",
      sessionId: "s1",
      messageId: "msg-1",
      success: true,
      summary: "wrong request",
    });
    ws.emit({
      type: "voice_summary_response",
      requestId,
      sessionId: "other-session",
      messageId: "msg-1",
      success: true,
      summary: "wrong session",
    });
    ws.emit({
      type: "voice_summary_response",
      requestId,
      sessionId: "s1",
      messageId: "other-message",
      success: true,
      summary: "wrong message",
    });
    ws.emit({
      type: "voice_summary_response",
      requestId,
      sessionId: "s1",
      messageId: "msg-1",
      success: true,
      summary: "这段代码把 x 设为 1。",
    });

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "voice_summary_request",
      requestId,
      sessionId: "s1",
      messageId: "msg-1",
      text: "```ts\nconst x = 1;\n```",
      reason: "code",
    });
    await expect(promise).resolves.toEqual({
      sessionId: "s1",
      messageId: "msg-1",
      success: true,
      summary: "这段代码把 x 设为 1。",
      error: undefined,
      errorCode: undefined,
    });
  });

  it("waits for matching session history responses", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestSessionHistory();
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "session_history_response",
      requestId: "other-request",
      success: true,
      sessions: [{ id: "old", title: "old", projectDir: "/old", updatedAt: 1 }],
    });
    ws.emit({
      type: "session_history_response",
      requestId,
      success: true,
      sessions: [{ id: "new", title: "new", projectDir: "/new", updatedAt: 2 }],
    });

    await expect(promise).resolves.toEqual([
      { id: "new", title: "new", projectDir: "/new", updatedAt: 2 },
    ]);
  });

  it("rejects an explicit session history scan failure instead of treating it as empty", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestSessionHistory();
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "session_history_response",
      requestId,
      success: false,
      sessions: [],
      errorCode: "UNKNOWN",
      error: "历史会话扫描失败",
    });

    await expect(promise).rejects.toThrow("历史会话扫描失败");
  });

  it("waits for matching session message responses", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestSessionMessages("s1");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "session_history_messages",
      requestId: "other-request",
      sessionId: "s1",
      messages: [{ role: "user", text: "wrong" }],
    });
    ws.emit({
      type: "session_history_messages",
      requestId,
      sessionId: "other-session",
      messages: [{ role: "user", text: "wrong session" }],
    });
    ws.emit({
      type: "session_history_messages",
      requestId,
      sessionId: "s1",
      messages: [{ role: "assistant", text: "hello" }],
    });

    await expect(promise).resolves.toEqual([{ role: "assistant", text: "hello" }]);
  });

  it("requests paginated session message pages", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestSessionMessagesPage("s1", { limit: 25, before: "b:2000" });
    const request = JSON.parse(ws.sent[0] ?? "{}") as {
      type?: string;
      limit?: number;
      before?: string;
      requestId?: string;
    };

    expect(request).toMatchObject({
      type: "session_messages_request",
      limit: 25,
      before: "b:2000",
    });

    ws.emit({
      type: "session_history_messages",
      requestId: request.requestId,
      sessionId: "s1",
      before: "b:2000",
      hasMore: true,
      nextBefore: "b:1200",
      messages: [{ role: "user", text: "older", cursor: "b:1500" }],
    });

    await expect(promise).resolves.toEqual({
      messages: [{ role: "user", text: "older", cursor: "b:1500" }],
      hasMore: true,
      nextBefore: "b:1200",
      before: "b:2000",
    });
  });

  it("waits for matching agent status snapshots", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestAgentStatuses("s1");
    const requestId = sentRequestId(ws);

    ws.emit({ type: "agent_status_response", requestId: "other-request", statuses: [] });
    ws.emit({
      type: "agent_status_response",
      requestId,
      statuses: [
        {
          sessionId: "s1",
          payload: {
            provider: "claude",
            phase: "thinking",
            seq: 1,
            updatedAt: 1760000000000,
          },
        },
      ],
    });

    await expect(promise).resolves.toEqual([
      {
        sessionId: "s1",
        payload: {
          provider: "claude",
          phase: "thinking",
          seq: 1,
          updatedAt: 1760000000000,
        },
      },
    ]);
  });

  it("waits for matching session resource snapshots", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestSessionResources("s1");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "session_resources_response",
      requestId: "other-request",
      sessionId: "s1",
      commands: [],
      groups: [],
    });
    ws.emit({
      type: "session_resources_response",
      requestId,
      sessionId: "other-session",
      commands: [],
      groups: [],
    });
    ws.emit({
      type: "session_resources_response",
      requestId,
      sessionId: "s1",
      commands: [{ name: "/init", description: "Initialize", source: "builtin" }],
      groups: [{ path: "/tmp", entries: [{ name: "src", isDir: true }] }],
    });

    await expect(promise).resolves.toEqual({
      sessionId: "s1",
      commands: [{ name: "/init", description: "Initialize", source: "builtin" }],
      groups: [{ path: "/tmp", entries: [{ name: "src", isDir: true }] }],
      error: undefined,
      errorCode: undefined,
    });
  });

  it("rejects pending request immediately when relay_error carries the same requestId", async () => {
    const { relay, ws } = createClient();
    const promise = relay.requestProxyList(60_000);
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "relay_error",
      code: "INVALID_MESSAGE",
      message: "Message matches neither RelayControl nor MessageEnvelope",
      requestId,
    });

    // 不等 timeout, 立刻拒掉, 错误信息带上 relay 给的原因
    await expect(promise).rejects.toThrow(
      /Relay 服务器拒绝请求.*Message matches neither RelayControl nor MessageEnvelope/,
    );
  });

  it("ignores relay_error whose requestId does not match the pending request", async () => {
    vi.useFakeTimers();
    try {
      const { relay, ws } = createClient();
      const promise = relay.requestProxyList(100);
      sentRequestId(ws);

      ws.emit({
        type: "relay_error",
        code: "INVALID_MESSAGE",
        message: "for someone else",
        requestId: "unrelated-request",
      });

      const assertion = expect(promise).rejects.toThrow("请求开发机列表超时");
      await vi.advanceTimersByTimeAsync(100);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("correlates concurrent session create responses by requestId", async () => {
    const { relay, ws } = createClient();
    const first = relay.createSession({ cwd: "/one", provider: "claude", mode: "pty" });
    const second = relay.createSession({ cwd: "/two", provider: "codex", mode: "pty" });
    const firstRequestId = sentRequestId(ws, 0);
    const secondRequestId = sentRequestId(ws, 1);

    ws.emit({
      type: "session_create_response",
      requestId: secondRequestId,
      sessionId: "second-session",
      mode: "pty",
      provider: "codex",
    });
    ws.emit({
      type: "session_create_response",
      requestId: firstRequestId,
      sessionId: "first-session",
      mode: "pty",
      provider: "claude",
    });

    await expect(first).resolves.toMatchObject({ sessionId: "first-session" });
    await expect(second).resolves.toMatchObject({ sessionId: "second-session" });
  });

  it("adds a QR-safe adaptive geometry to PTY session creation", async () => {
    const { relay, ws } = createClient();
    const promise = relay.createSession({ cwd: "/tmp/project", provider: "codex", mode: "pty" });
    const requestId = sentRequestId(ws);
    const sent = JSON.parse(ws.sent[0] ?? "{}") as {
      cols?: number;
      rows?: number;
    };

    expect(sent.cols).toBeGreaterThanOrEqual(80);
    expect(sent.rows).toBeGreaterThanOrEqual(24);

    ws.emit({
      type: "session_create_response",
      requestId,
      sessionId: "adaptive-session",
      mode: "pty",
      provider: "codex",
    });
    await expect(promise).resolves.toMatchObject({ sessionId: "adaptive-session" });
  });

  it("does not add terminal geometry to JSON session creation", async () => {
    const { relay, ws } = createClient();
    const promise = relay.createSession({ cwd: "/tmp/project", provider: "claude", mode: "json" });
    const requestId = sentRequestId(ws);
    const sent = JSON.parse(ws.sent[0] ?? "{}") as {
      cols?: number;
      rows?: number;
    };

    expect(sent.cols).toBeUndefined();
    expect(sent.rows).toBeUndefined();

    ws.emit({
      type: "session_create_response",
      requestId,
      sessionId: "json-session",
      mode: "json",
      provider: "claude",
    });
    await expect(promise).resolves.toMatchObject({ sessionId: "json-session" });
  });

  it("measures Web to Relay latency by requestId", async () => {
    const { relay, ws } = createClient();
    const promise = relay.measureWebRelayLatency();
    const requestId = sentRequestId(ws);

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "latency_web_relay_ping",
      requestId,
    });

    ws.emit({ type: "latency_web_relay_pong", requestId });

    await expect(promise).resolves.toMatchObject({
      success: true,
      rttMs: expect.any(Number),
    });
  });

  it("measures Relay to proxy latency from relay response payload", async () => {
    const { relay, ws } = createClient();
    const promise = relay.measureRelayProxyLatency();
    const requestId = sentRequestId(ws);

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "latency_relay_proxy_request",
      requestId,
    });

    ws.emit({
      type: "latency_relay_proxy_response",
      requestId,
      success: true,
      rttMs: 24.5,
    });

    await expect(promise).resolves.toEqual({
      success: true,
      rttMs: 24.5,
      error: undefined,
    });
  });

  it("measures Web to proxy latency by requestId", async () => {
    const { relay, ws } = createClient();
    const promise = relay.measureWebProxyLatency();
    const requestId = sentRequestId(ws);

    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "latency_web_proxy_ping",
      requestId,
    });

    ws.emit({ type: "latency_web_proxy_pong", requestId });

    await expect(promise).resolves.toMatchObject({
      success: true,
      rttMs: expect.any(Number),
    });
  });

  it("requests scoped Web preview capability with explicit PATH refresh", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const promise = relay.requestWebPreviewCapability(scope, true);
    const requestId = sentRequestId(ws);

    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "preview_capability_request",
      requestId,
      scope,
      refreshPath: true,
    });

    ws.emit({
      type: "preview_capability_response",
      requestId,
      scope,
      success: true,
      capability: {
        cloudflared: { available: true, command: "/opt/homebrew/bin/cloudflared" },
        cpolar: { available: false, error: "cpolar not found" },
      },
    });

    await expect(promise).resolves.toEqual({
      success: true,
      capability: {
        cloudflared: { available: true, command: "/opt/homebrew/bin/cloudflared" },
        cpolar: { available: false, error: "cpolar not found" },
      },
    });
  });

  it("returns strict capability failures and cancels scoped capability requests", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const failed = relay.requestWebPreviewCapability(scope, false);
    const failedRequestId = sentRequestId(ws);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({
      type: "preview_capability_request",
      scope,
      refreshPath: false,
    });
    ws.emit({
      type: "preview_capability_response",
      requestId: failedRequestId,
      scope,
      success: false,
      error: "detection failed",
      errorCode: "UNKNOWN",
    });
    await expect(failed).resolves.toEqual({
      success: false,
      error: "detection failed",
      errorCode: "UNKNOWN",
    });

    const abort = new AbortController();
    const cancelled = relay.requestWebPreviewCapability(scope, false, { signal: abort.signal });
    abort.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  });

  it("requests Device preview capability with the same strict result contract", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const promise = relay.requestDevicePreviewCapability(scope, false);
    const requestId = sentRequestId(ws);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "device_preview_capability_request",
      requestId,
      scope,
      refreshPath: false,
    });
    ws.emit({
      type: "device_preview_capability_response",
      requestId,
      scope,
      success: true,
      capability: {
        ios: {
          supported: true,
          available: true,
          interactive: true,
          command: "/usr/bin/xcrun",
        },
        android: {
          supported: true,
          available: false,
          interactive: false,
          error: "adb not found",
        },
      },
    });
    await expect(promise).resolves.toMatchObject({
      success: true,
      capability: { ios: { available: true } },
    });
  });

  it("inspects static previews in the active scope with request correlation", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const promise = relay.inspectStaticWebPreview(scope, "/home/dev/site");
    const requestId = sentRequestId(ws);

    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "preview_static_inspect_request",
      requestId,
      scope,
      path: "/home/dev/site",
    });
    ws.emit({
      type: "preview_static_inspect_response",
      requestId: "other-request",
      scope,
      success: true,
      entryPath: "wrong.html",
      htmlEntries: ["wrong.html"],
    });
    ws.emit({
      type: "preview_static_inspect_response",
      requestId,
      scope,
      success: true,
      htmlEntries: ["home.html", "pages/docs.html"],
    });

    await expect(promise).resolves.toEqual({
      success: true,
      entryPath: undefined,
      htmlEntries: ["home.html", "pages/docs.html"],
    });
  });

  it("creates a web preview with a required operation id and echoes the matching ACK", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const operationId = "web-create-operation-1";
    const promise = relay.createWebPreview(
      scope,
      { kind: "local", url: "http://localhost:5173/admin" },
      { tunnelProvider: "cloudflare", name: "Project docs", operationId },
    );
    const requestId = sentRequestId(ws);

    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "preview_create_request",
      requestId,
      scope,
      operationId,
      source: { kind: "local", url: "http://localhost:5173/admin" },
      tunnelProvider: "cloudflare",
      name: "Project docs",
    });
    ws.emit({
      type: "preview_create_response",
      requestId,
      scope: { ...scope, bindingId: `${scope.bindingId}-stale` },
      operationId,
      accepted: true,
      previewId: "stale-preview",
    });
    ws.emit({
      type: "preview_create_response",
      requestId,
      scope,
      operationId: "wrong-operation",
      accepted: true,
      previewId: "wrong-preview",
    });
    ws.emit({
      type: "preview_create_response",
      requestId,
      scope,
      operationId,
      accepted: true,
      previewId: "preview-1",
    });

    await expect(promise).resolves.toEqual({
      operationId,
      accepted: true,
      previewId: "preview-1",
    });
  });

  it("preserves a caller operation id for an idempotent web preview retry", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const operationId = "preview-operation-cpolar-stable";
    const promise = relay.createWebPreview(
      scope,
      { kind: "local", url: "http://localhost:4173" },
      { tunnelProvider: "cpolar", operationId },
    );
    const requestId = sentRequestId(ws);

    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "preview_create_request",
      requestId,
      scope,
      operationId,
      source: { kind: "local", url: "http://localhost:4173" },
      tunnelProvider: "cpolar",
    });
    ws.emit({
      type: "preview_create_response",
      requestId,
      scope,
      operationId,
      accepted: true,
      previewId: "preview-stable",
    });

    await expect(promise).resolves.toMatchObject({
      operationId,
      accepted: true,
      previewId: "preview-stable",
    });
  });

  it("renames a web preview only from the matching operation response", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const operationId = "web-rename-operation-1";
    const promise = relay.renameWebPreview(scope, "preview-1", "Project docs", { operationId });
    const requestId = sentRequestId(ws);

    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "preview_rename_request",
      requestId,
      scope,
      operationId,
      previewId: "preview-1",
      name: "Project docs",
    });
    ws.emit({
      type: "preview_rename_response",
      requestId,
      scope,
      operationId: "wrong-operation",
      previewId: "preview-1",
      success: true,
    });
    ws.emit({
      type: "preview_rename_response",
      requestId,
      scope,
      operationId,
      previewId: "preview-1",
      success: true,
    });

    await expect(promise).resolves.toEqual({
      operationId,
      previewId: "preview-1",
      success: true,
    });
  });

  it("creates and renames a device preview with scope and operation correlation", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const createOperationId = "device-create-operation-1";
    const createPromise = relay.createDevicePreview(scope, "emulator-5554", {
      name: "Pixel checkout",
      operationId: createOperationId,
    });
    const createRequestId = sentRequestId(ws);

    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "device_preview_create_request",
      requestId: createRequestId,
      scope,
      operationId: createOperationId,
      targetId: "emulator-5554",
      name: "Pixel checkout",
    });
    ws.emit({
      type: "device_preview_create_response",
      requestId: createRequestId,
      scope,
      operationId: "wrong-operation",
      accepted: true,
      previewId: "wrong-preview",
    });
    ws.emit({
      type: "device_preview_create_response",
      requestId: createRequestId,
      scope,
      operationId: createOperationId,
      accepted: true,
      previewId: "device-preview-1",
    });
    await expect(createPromise).resolves.toMatchObject({
      operationId: createOperationId,
      accepted: true,
      previewId: "device-preview-1",
    });

    const renameOperationId = "device-rename-operation-1";
    const renamePromise = relay.renameDevicePreview(scope, "device-preview-1", "Checkout phone", {
      operationId: renameOperationId,
    });
    const renameRequestId = sentRequestId(ws, 1);
    expect(JSON.parse(ws.sent[1] ?? "{}")).toEqual({
      type: "device_preview_rename_request",
      requestId: renameRequestId,
      scope,
      operationId: renameOperationId,
      previewId: "device-preview-1",
      name: "Checkout phone",
    });
    ws.emit({
      type: "device_preview_rename_response",
      requestId: renameRequestId,
      scope,
      operationId: "wrong-operation",
      previewId: "device-preview-1",
      success: true,
    });
    ws.emit({
      type: "device_preview_rename_response",
      requestId: renameRequestId,
      scope,
      operationId: renameOperationId,
      previewId: "device-preview-1",
      success: true,
    });
    await expect(renamePromise).resolves.toEqual({
      operationId: renameOperationId,
      previewId: "device-preview-1",
      success: true,
    });
  });

  it("loads and mutates web previews through scoped, operation-correlated messages", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const listPromise = relay.requestWebPreviewList(scope);
    const listRequestId = sentRequestId(ws);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "preview_list_request",
      requestId: listRequestId,
      scope,
    });
    ws.emit({
      type: "preview_list_response",
      requestId: listRequestId,
      scope,
      epoch: "epoch-a",
      revision: 3,
      previews: [],
    });
    await expect(listPromise).resolves.toEqual({
      epoch: "epoch-a",
      revision: 3,
      previews: [],
    });

    const reconnectOperationId = "web-reconnect-operation-1";
    const reconnectPromise = relay.reconnectWebPreview(scope, "preview-1", {
      operationId: reconnectOperationId,
    });
    const reconnectRequestId = sentRequestId(ws, 1);
    expect(JSON.parse(ws.sent[1] ?? "{}")).toEqual({
      type: "preview_reconnect_request",
      requestId: reconnectRequestId,
      scope,
      operationId: reconnectOperationId,
      previewId: "preview-1",
    });
    ws.emit({
      type: "preview_reconnect_response",
      requestId: reconnectRequestId,
      scope,
      operationId: "wrong-operation",
      previewId: "preview-1",
      success: true,
    });
    ws.emit({
      type: "preview_reconnect_response",
      requestId: reconnectRequestId,
      scope,
      operationId: reconnectOperationId,
      previewId: "preview-1",
      success: true,
    });
    await expect(reconnectPromise).resolves.toEqual({
      operationId: reconnectOperationId,
      previewId: "preview-1",
      success: true,
    });

    const closeOperationId = "web-close-operation-1";
    const closePromise = relay.closeWebPreview(scope, "preview-1", {
      operationId: closeOperationId,
    });
    const closeRequestId = sentRequestId(ws, 2);
    expect(JSON.parse(ws.sent[2] ?? "{}")).toEqual({
      type: "preview_close_request",
      requestId: closeRequestId,
      scope,
      operationId: closeOperationId,
      previewId: "preview-1",
    });
    ws.emit({
      type: "preview_close_response",
      requestId: closeRequestId,
      scope,
      operationId: "wrong-operation",
      previewId: "preview-1",
      success: true,
    });
    ws.emit({
      type: "preview_close_response",
      requestId: closeRequestId,
      scope,
      operationId: closeOperationId,
      previewId: "preview-1",
      success: true,
    });
    await expect(closePromise).resolves.toEqual({
      operationId: closeOperationId,
      previewId: "preview-1",
      success: true,
    });
  });

  it("loads and mutates device previews through scoped, operation-correlated messages", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const listPromise = relay.requestDevicePreviewList(scope);
    const listRequestId = sentRequestId(ws);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "device_preview_list_request",
      requestId: listRequestId,
      scope,
    });
    ws.emit({
      type: "device_preview_list_response",
      requestId: listRequestId,
      scope,
      epoch: "device-epoch-a",
      revision: 3,
      previews: [],
    });
    await expect(listPromise).resolves.toEqual({
      epoch: "device-epoch-a",
      revision: 3,
      previews: [],
    });

    const reconnectOperationId = "device-reconnect-operation-1";
    const reconnectPromise = relay.reconnectDevicePreview(scope, "device-preview-1", {
      operationId: reconnectOperationId,
    });
    const reconnectRequestId = sentRequestId(ws, 1);
    expect(JSON.parse(ws.sent[1] ?? "{}")).toEqual({
      type: "device_preview_reconnect_request",
      requestId: reconnectRequestId,
      scope,
      operationId: reconnectOperationId,
      previewId: "device-preview-1",
    });
    ws.emit({
      type: "device_preview_reconnect_response",
      requestId: reconnectRequestId,
      scope,
      operationId: "wrong-operation",
      previewId: "device-preview-1",
      success: true,
    });
    ws.emit({
      type: "device_preview_reconnect_response",
      requestId: reconnectRequestId,
      scope,
      operationId: reconnectOperationId,
      previewId: "device-preview-1",
      success: true,
    });
    await expect(reconnectPromise).resolves.toEqual({
      operationId: reconnectOperationId,
      previewId: "device-preview-1",
      success: true,
    });

    const closeOperationId = "device-close-operation-1";
    const closePromise = relay.closeDevicePreview(scope, "device-preview-1", {
      operationId: closeOperationId,
    });
    const closeRequestId = sentRequestId(ws, 2);
    expect(JSON.parse(ws.sent[2] ?? "{}")).toEqual({
      type: "device_preview_close_request",
      requestId: closeRequestId,
      scope,
      operationId: closeOperationId,
      previewId: "device-preview-1",
    });
    ws.emit({
      type: "device_preview_close_response",
      requestId: closeRequestId,
      scope,
      operationId: "wrong-operation",
      previewId: "device-preview-1",
      success: true,
    });
    ws.emit({
      type: "device_preview_close_response",
      requestId: closeRequestId,
      scope,
      operationId: closeOperationId,
      previewId: "device-preview-1",
      success: true,
    });
    await expect(closePromise).resolves.toEqual({
      operationId: closeOperationId,
      previewId: "device-preview-1",
      success: true,
    });
  });

  it("scopes Device Preview stream, input, and control traffic to one binding", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const signal = new AbortController().signal;
    const streamPromise = relay.requestDevicePreviewStream(
      scope,
      "device-preview-1",
      { format: "jpeg", maxFps: 15 },
      { timeoutMs: 500, signal },
    );
    const streamRequestId = sentRequestId(ws);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "device_preview_stream_url_request",
      requestId: streamRequestId,
      scope,
      previewId: "device-preview-1",
      profile: { format: "jpeg", maxFps: 15 },
    });
    ws.emit({
      type: "device_preview_stream_url_response",
      requestId: streamRequestId,
      scope,
      previewId: "device-preview-1",
      success: true,
      url: "/api/device-preview-streams/token-1",
      leaseId: "lease-1",
      expiresAt: Date.now() + 20_000,
      controlMode: "controller",
    });
    await expect(streamPromise).resolves.toMatchObject({ success: true, leaseId: "lease-1" });

    const inputPromise = relay.sendDevicePreviewInput(
      scope,
      "lease-1",
      { kind: "button", button: "home" },
      { timeoutMs: 500, signal },
    );
    expect(JSON.parse(ws.sent[1] ?? "{}")).toEqual({
      type: "device_preview_input",
      scope,
      leaseId: "lease-1",
      inputSeq: 1,
      input: { kind: "button", button: "home" },
    });
    ws.emit({
      type: "device_preview_input_ack",
      scope,
      leaseId: "lease-1",
      inputSeq: 1,
      success: true,
    });
    await expect(inputPromise).resolves.toMatchObject({ success: true, leaseId: "lease-1" });

    const claimPromise = relay.claimDevicePreviewControl(scope, "lease-1", {
      timeoutMs: 500,
      signal,
    });
    const claimRequestId = sentRequestId(ws, 2);
    expect(JSON.parse(ws.sent[2] ?? "{}")).toEqual({
      type: "device_preview_control_claim_request",
      requestId: claimRequestId,
      scope,
      leaseId: "lease-1",
    });
    ws.emit({
      type: "device_preview_control_claim_response",
      requestId: claimRequestId,
      scope,
      leaseId: "lease-1",
      success: true,
      controlMode: "controller",
    });
    await expect(claimPromise).resolves.toMatchObject({
      success: true,
      controlMode: "controller",
    });
  });

  it("rejects all Device Preview data-plane calls from an obsolete binding", async () => {
    const { relay, ws } = createClient();
    const oldScope = restorePreviewScope(relay, ws, "proxy-a", "binding-a-1");
    restorePreviewScope(relay, ws, "proxy-a", "binding-a-2");
    const signal = new AbortController().signal;

    await expect(
      relay.requestDevicePreviewStream(
        oldScope,
        "device-preview-1",
        { format: "jpeg" },
        { signal },
      ),
    ).rejects.toThrow("预览上下文已失效");
    await expect(
      relay.sendDevicePreviewInput(
        oldScope,
        "lease-1",
        { kind: "button", button: "home" },
        { signal },
      ),
    ).rejects.toThrow("预览上下文已失效");
    await expect(relay.claimDevicePreviewControl(oldScope, "lease-1", { signal })).rejects.toThrow(
      "预览上下文已失效",
    );
    expect(ws.sent).toEqual([]);
  });

  it("cancels a pending Device Preview stream URL request", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const abort = new AbortController();
    const pending = relay.requestDevicePreviewStream(
      scope,
      "device-preview-1",
      { format: "jpeg" },
      { signal: abort.signal },
    );
    expect(ws.sent).toHaveLength(1);

    abort.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "请求已取消" });
  });

  it("rejects an obsolete binding after A -> B -> A and sends only the current scope", async () => {
    const { relay, ws } = createClient();
    const oldAScope = restorePreviewScope(relay, ws, "proxy-a", "binding-a-1");
    restorePreviewScope(relay, ws, "proxy-b", "binding-b-1");
    const currentAScope = restorePreviewScope(relay, ws, "proxy-a", "binding-a-2");

    await expect(relay.requestWebPreviewList(oldAScope)).rejects.toThrow("预览上下文已失效");
    expect(ws.sent).toEqual([]);

    const promise = relay.requestWebPreviewList(currentAScope);
    const requestId = sentRequestId(ws);
    expect(JSON.parse(ws.sent[0] ?? "{}")).toEqual({
      type: "preview_list_request",
      requestId,
      scope: { proxyId: "proxy-a", bindingId: "binding-a-2" },
    });
    ws.emit({
      type: "preview_list_response",
      requestId,
      scope: currentAScope,
      epoch: "current-a",
      revision: 1,
      previews: [],
    });
    await expect(promise).resolves.toMatchObject({ epoch: "current-a", revision: 1 });
  });

  it("cancels an in-flight scoped preview request with AbortSignal", async () => {
    const { relay, ws } = createClient();
    const scope = restorePreviewScope(relay, ws);
    const controller = new AbortController();
    const cancelled = relay.requestWebPreviewList(scope, { signal: controller.signal });
    const cancelledRequestId = sentRequestId(ws);

    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError", message: "请求已取消" });

    ws.emit({
      type: "preview_list_response",
      requestId: cancelledRequestId,
      scope,
      epoch: "stale",
      revision: 99,
      previews: [],
    });
    const current = relay.requestWebPreviewList(scope);
    const currentRequestId = sentRequestId(ws, 1);
    ws.emit({
      type: "preview_list_response",
      requestId: currentRequestId,
      scope,
      epoch: "current",
      revision: 1,
      previews: [],
    });
    await expect(current).resolves.toMatchObject({ epoch: "current", revision: 1 });
  });
});
