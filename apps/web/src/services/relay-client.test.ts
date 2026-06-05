import { afterEach, describe, expect, it, vi } from "vitest";
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
        },
      ],
    });

    await expect(promise).resolves.toEqual([
      { clientId: "client-1", connectedAt: 1760000000000, current: true },
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
    const promise = relay.requestDirectoryList("/home/dev");
    const requestId = sentRequestId(ws);

    ws.emit({
      type: "dir_list_response",
      requestId: "other-request",
      path: "/home/dev",
      entries: [{ name: "wrong", isDir: true }],
    });
    ws.emit({
      type: "dir_list_response",
      requestId,
      path: "/home/dev",
      entries: [{ name: "workspace", isDir: true }],
    });

    await expect(promise).resolves.toEqual({
      path: "/home/dev",
      entries: [{ name: "workspace", isDir: true }],
      error: undefined,
      errorCode: undefined,
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

    ws.emit({ type: "proxy_info", requestId: "other-request", homePath: "/tmp", agentCli });
    ws.emit({ type: "proxy_info", requestId, homePath: "/home/dev", agentCli });

    await expect(promise).resolves.toEqual({ homePath: "/home/dev", agentCli });
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
      sessions: [{ id: "old", title: "old", projectDir: "/old", updatedAt: 1 }],
    });
    ws.emit({
      type: "session_history_response",
      requestId,
      sessions: [{ id: "new", title: "new", projectDir: "/new", updatedAt: 2 }],
    });

    await expect(promise).resolves.toEqual([
      { id: "new", title: "new", projectDir: "/new", updatedAt: 2 },
    ]);
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
});
