import { describe, it, expect } from "vitest";
import {
  ClientToProxyRelayControlTypes,
  isClientToProxyRelayControlType,
  isProxyToClientRelayControlType,
  ProxyToClientRelayControlTypes,
  RELAY_CONTROL_PROTOCOL_VERSION,
  RelayControlSchema,
} from "../relay-control.js";

describe("RelayControlSchema", () => {
  it("rejects proxy_register with empty proxyId", () => {
    expect(() =>
      RelayControlSchema.parse({
        type: "proxy_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        proxyId: "",
        proxyVersion: "0.9.0",
      }),
    ).toThrow();
  });

  it("requires both sides of Proxy registration to report their version", () => {
    expect(
      RelayControlSchema.safeParse({
        type: "proxy_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        proxyId: "proxy-1",
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "proxy_register_response",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        status: "new",
        connectionId: "connection-1",
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      type: "proxy_register",
      proxyId: "proxy-1",
      proxyVersion: "0.9.0",
    },
    {
      type: "proxy_register_response",
      status: "new",
      relayVersion: "0.9.0",
      connectionId: "connection-1",
    },
    {
      type: "client_register",
      clientId: "client-1",
      userAgent: "test",
      platform: "test",
      maxTouchPoints: 0,
      browserName: "test",
      osName: "test",
      deviceKind: "desktop",
    },
    {
      type: "client_register_response",
      status: "new",
    },
  ])("requires the current Relay control protocol for $type", (message) => {
    expect(
      RelayControlSchema.safeParse({
        ...message,
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
      }).success,
    ).toBe(true);
    expect(RelayControlSchema.safeParse(message).success).toBe(false);
    expect(RelayControlSchema.safeParse({ ...message, protocolVersion: 0 }).success).toBe(false);
  });

  it("rejects unknown type", () => {
    expect(() => RelayControlSchema.parse({ type: "unknown_type" })).toThrow();
  });

  it("derives proxy-to-client control routing from protocol metadata", () => {
    expect(isProxyToClientRelayControlType("agent_status")).toBe(true);
    expect(isProxyToClientRelayControlType("session_snapshot")).toBe(true);
    expect(isProxyToClientRelayControlType("proxy_register")).toBe(false);
    expect(isProxyToClientRelayControlType("session_sync")).toBe(false);
    expect(ProxyToClientRelayControlTypes.has("remote_input_raw")).toBe(false);
  });

  it("derives client-to-proxy control routing from protocol metadata", () => {
    expect(isClientToProxyRelayControlType("agent_status_request")).toBe(true);
    expect(isClientToProxyRelayControlType("permission_request_delivered")).toBe(true);
    expect(isClientToProxyRelayControlType("tool_approve")).toBe(true);
    expect(isClientToProxyRelayControlType("tool_deny")).toBe(true);
    expect(isClientToProxyRelayControlType("session_resources_request")).toBe(true);
    expect(isClientToProxyRelayControlType("session_rename")).toBe(true);
    expect(isClientToProxyRelayControlType("session_list_request")).toBe(true);
    expect(isClientToProxyRelayControlType("voice_summary_request")).toBe(true);
    expect(isClientToProxyRelayControlType("agent_status")).toBe(false);
    expect(isClientToProxyRelayControlType("permission_decision_result")).toBe(false);
    expect(isClientToProxyRelayControlType("voice_config_request")).toBe(false);
    expect(isClientToProxyRelayControlType("voice_capabilities_request")).toBe(false);
    expect(ClientToProxyRelayControlTypes.has("dir_list_response")).toBe(false);
  });

  it("preserves dynamic approval options and exact decisions", () => {
    expect(
      RelayControlSchema.parse({
        type: "pending_approvals_push",
        sessionId: "session-1",
        approvals: [
          {
            requestId: "request-1",
            toolName: "AskUserQuestion",
            input: { question: "Choose an action" },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ],
          },
        ],
      }),
    ).toMatchObject({
      approvals: [
        {
          options: [
            { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject-once", name: "Reject", kind: "reject_once" },
          ],
        },
      ],
    });

    expect(
      RelayControlSchema.parse({
        type: "tool_approve",
        sessionId: "session-1",
        payload: { toolId: "request-1", optionId: "allow-once" },
      }),
    ).toMatchObject({ payload: { optionId: "allow-once" } });
    expect(
      RelayControlSchema.parse({
        type: "tool_deny",
        sessionId: "session-1",
        payload: { toolId: "request-1", optionId: "reject-once" },
      }),
    ).toMatchObject({ payload: { optionId: "reject-once" } });
  });

  it("parses relay-local voice config controls without routing them to proxy", () => {
    expect(
      RelayControlSchema.parse({
        type: "voice_config_request",
        requestId: "voice-config-1",
      }),
    ).toEqual({
      type: "voice_config_request",
      requestId: "voice-config-1",
    });

    expect(
      RelayControlSchema.parse({
        type: "voice_config_response",
        requestId: "voice-config-1",
        config: {
          provider: "aliyun-bailian",
          configured: true,
          region: "cn",
          asrModel: "qwen3-asr-flash-realtime",
          ttsModel: "cosyvoice-v3-flash",
          ttsVoice: "longanyang",
          turnIdleSeconds: 5,
        },
      }),
    ).toMatchObject({
      type: "voice_config_response",
      requestId: "voice-config-1",
      config: {
        provider: "aliyun-bailian",
        configured: true,
      },
    });

    expect(
      RelayControlSchema.parse({
        type: "voice_config_update",
        requestId: "voice-update-1",
        config: {
          provider: "aliyun-bailian",
          apiKey: "sk-secret",
          region: "intl",
          asrModel: "qwen3-asr-flash-realtime",
          ttsModel: "cosyvoice-v3-flash",
          ttsVoice: "longanyang",
          turnIdleSeconds: 5,
        },
      }),
    ).toMatchObject({
      type: "voice_config_update",
      requestId: "voice-update-1",
      config: {
        apiKey: "sk-secret",
      },
    });

    expect(isClientToProxyRelayControlType("voice_config_request")).toBe(false);
    expect(isProxyToClientRelayControlType("voice_config_response")).toBe(false);
  });

  it("parses relay-local voice capability controls without routing them to proxy", () => {
    expect(
      RelayControlSchema.parse({
        type: "voice_capabilities_request",
        requestId: "voice-capabilities-1",
        region: "cn",
      }),
    ).toEqual({
      type: "voice_capabilities_request",
      requestId: "voice-capabilities-1",
      region: "cn",
    });

    expect(
      RelayControlSchema.parse({
        type: "voice_capabilities_response",
        requestId: "voice-capabilities-1",
        capabilities: {
          asrModels: [
            {
              value: "qwen3-asr-flash-realtime",
              label: "Qwen3 ASR Flash Realtime",
              source: "official",
            },
          ],
          ttsModels: [
            {
              value: "cosyvoice-v3-flash",
              label: "CosyVoice V3 Flash",
              source: "official",
            },
          ],
          ttsVoices: [
            {
              value: "longanhuan",
              label: "龙安欢 · 女 · 欢脱元气 · 20-30",
              gender: "female",
              age: "20-30",
              model: "cosyvoice-v3-flash",
              source: "official",
            },
          ],
          fetchedAt: 1760000000000,
        },
      }),
    ).toMatchObject({
      type: "voice_capabilities_response",
      requestId: "voice-capabilities-1",
      capabilities: {
        asrModels: [{ value: "qwen3-asr-flash-realtime" }],
        ttsVoices: [{ value: "longanhuan", gender: "female" }],
      },
    });

    expect(isClientToProxyRelayControlType("voice_capabilities_request")).toBe(false);
    expect(isProxyToClientRelayControlType("voice_capabilities_response")).toBe(false);
  });

  it("parses relay-local voice config test controls without routing them to proxy", () => {
    expect(
      RelayControlSchema.parse({
        type: "voice_config_test",
        requestId: "voice-test-1",
        config: {
          apiKey: "sk-secret",
          region: "cn",
          asrModel: "qwen3-asr-flash-realtime",
          ttsModel: "cosyvoice-v3-flash",
          ttsVoice: "longanyang",
        },
      }),
    ).toMatchObject({
      type: "voice_config_test",
      requestId: "voice-test-1",
      config: {
        apiKey: "sk-secret",
      },
    });

    expect(
      RelayControlSchema.parse({
        type: "voice_config_test_response",
        requestId: "voice-test-1",
        success: true,
        audioBase64: "AQI=",
        audioSampleRate: 16000,
        audioEncoding: "pcm_s16le",
        transcript: "语音助手测试",
      }),
    ).toEqual({
      type: "voice_config_test_response",
      requestId: "voice-test-1",
      success: true,
      audioBase64: "AQI=",
      audioSampleRate: 16000,
      audioEncoding: "pcm_s16le",
      transcript: "语音助手测试",
    });

    expect(isClientToProxyRelayControlType("voice_config_test")).toBe(false);
    expect(isProxyToClientRelayControlType("voice_config_test_response")).toBe(false);
  });

  it("rejects API keys in voice config responses", () => {
    expect(() =>
      RelayControlSchema.parse({
        type: "voice_config_response",
        requestId: "voice-config-1",
        config: {
          provider: "aliyun-bailian",
          configured: true,
          region: "cn",
          asrModel: "qwen3-asr-flash-realtime",
          ttsModel: "cosyvoice-v3-flash",
          ttsVoice: "longanyang",
          turnIdleSeconds: 5,
          apiKey: "sk-secret",
        },
      }),
    ).toThrow();
  });

  it("parses voice summary request and response controls", () => {
    expect(
      RelayControlSchema.parse({
        type: "voice_summary_request",
        requestId: "voice-summary-1",
        sessionId: "sess-1",
        messageId: "msg-1",
        text: "```ts\nconst x = 1;\n```",
        reason: "code",
      }),
    ).toMatchObject({
      type: "voice_summary_request",
      requestId: "voice-summary-1",
      sessionId: "sess-1",
      reason: "code",
    });

    expect(
      RelayControlSchema.parse({
        type: "voice_summary_response",
        requestId: "voice-summary-1",
        sessionId: "sess-1",
        messageId: "msg-1",
        success: true,
        summary: "下面是摘要：这段代码定义了一个变量。",
      }),
    ).toMatchObject({
      type: "voice_summary_response",
      requestId: "voice-summary-1",
      success: true,
    });

    expect(isClientToProxyRelayControlType("voice_summary_request")).toBe(true);
    expect(isProxyToClientRelayControlType("voice_summary_response")).toBe(true);
  });

  it("parses session rename request and response with requestId correlation", () => {
    expect(
      RelayControlSchema.parse({
        type: "session_rename",
        requestId: "rename-1",
        sessionId: "sess-1",
        name: "Release checklist",
      }),
    ).toEqual({
      type: "session_rename",
      requestId: "rename-1",
      sessionId: "sess-1",
      name: "Release checklist",
    });

    expect(
      RelayControlSchema.parse({
        type: "session_rename_response",
        requestId: "rename-1",
        sessionId: "sess-1",
        success: true,
        name: "Release checklist",
      }),
    ).toMatchObject({
      type: "session_rename_response",
      requestId: "rename-1",
      sessionId: "sess-1",
      success: true,
      name: "Release checklist",
    });
    expect(isProxyToClientRelayControlType("session_rename_response")).toBe(true);
  });

  it("parses remote file URL and stream controls without exposing stream controls to client routing", () => {
    expect(
      RelayControlSchema.parse({
        type: "remote_file_url_request",
        requestId: "file-url-1",
        sessionId: "sess-1",
        path: "build/out.tar.gz",
        disposition: "download",
      }),
    ).toEqual({
      type: "remote_file_url_request",
      requestId: "file-url-1",
      sessionId: "sess-1",
      path: "build/out.tar.gz",
      disposition: "download",
    });

    expect(
      RelayControlSchema.parse({
        type: "remote_file_url_response",
        requestId: "file-url-1",
        sessionId: "sess-1",
        path: "build/out.tar.gz",
        success: true,
        url: "/api/remote-files/token-1",
        expiresAt: 123,
      }),
    ).toMatchObject({
      type: "remote_file_url_response",
      success: true,
      url: "/api/remote-files/token-1",
    });

    expect(
      RelayControlSchema.parse({
        type: "remote_file_stream_response",
        streamId: "stream-1",
        sessionId: "sess-1",
        success: true,
        path: "build/out.tar.gz",
        mimeType: "application/gzip",
        size: 1024,
        fileName: "out.tar.gz",
      }),
    ).toMatchObject({
      type: "remote_file_stream_response",
      streamId: "stream-1",
      success: true,
    });

    expect(
      RelayControlSchema.parse({
        type: "remote_file_metadata_request",
        requestId: "meta-1",
        sessionId: "sess-1",
        path: "build/out.tar.gz",
      }),
    ).toEqual({
      type: "remote_file_metadata_request",
      requestId: "meta-1",
      sessionId: "sess-1",
      path: "build/out.tar.gz",
    });

    expect(
      RelayControlSchema.parse({
        type: "remote_file_metadata_response",
        requestId: "meta-1",
        sessionId: "sess-1",
        path: "build/out.tar.gz",
        success: true,
        mimeType: "application/gzip",
        size: 1024,
        fileName: "out.tar.gz",
      }),
    ).toMatchObject({
      type: "remote_file_metadata_response",
      requestId: "meta-1",
      success: true,
      fileName: "out.tar.gz",
    });

    expect(
      RelayControlSchema.parse({
        type: "remote_file_stream_complete",
        streamId: "stream-1",
        success: true,
      }),
    ).toEqual({
      type: "remote_file_stream_complete",
      streamId: "stream-1",
      success: true,
    });

    expect(isClientToProxyRelayControlType("remote_file_url_request")).toBe(false);
    expect(isClientToProxyRelayControlType("remote_file_metadata_request")).toBe(false);
    expect(isClientToProxyRelayControlType("remote_file_stream_request")).toBe(false);
    expect(isProxyToClientRelayControlType("remote_file_metadata_response")).toBe(false);
    expect(isProxyToClientRelayControlType("remote_file_stream_response")).toBe(false);
  });

  it("parses remote upload URL and stream controls without exposing them to client routing", () => {
    expect(
      RelayControlSchema.parse({
        type: "remote_file_upload_url_request",
        requestId: "upload-url-1",
        sessionId: "sess-1",
        kind: "clipboard_image",
        fileName: "shot.png",
        mimeType: "image/png",
        size: 123,
      }),
    ).toMatchObject({
      type: "remote_file_upload_url_request",
      requestId: "upload-url-1",
      kind: "clipboard_image",
    });

    expect(
      RelayControlSchema.parse({
        type: "remote_file_upload_url_response",
        requestId: "upload-url-1",
        sessionId: "sess-1",
        success: true,
        uploadUrl: "/api/remote-uploads/token-1",
        expiresAt: 123,
      }),
    ).toMatchObject({
      type: "remote_file_upload_url_response",
      success: true,
      uploadUrl: "/api/remote-uploads/token-1",
    });

    expect(
      RelayControlSchema.parse({
        type: "remote_file_upload_stream_request",
        uploadId: "upload-1",
        sessionId: "sess-1",
        kind: "file",
        fileName: "notes.txt",
        mimeType: "text/plain",
      }),
    ).toMatchObject({
      type: "remote_file_upload_stream_request",
      uploadId: "upload-1",
      kind: "file",
    });

    expect(
      RelayControlSchema.parse({
        type: "remote_file_upload_stream_response",
        uploadId: "upload-1",
        sessionId: "sess-1",
        success: true,
        path: "/tmp/dev-anywhere/up-abc.txt",
      }),
    ).toMatchObject({
      type: "remote_file_upload_stream_response",
      success: true,
    });

    expect(isClientToProxyRelayControlType("remote_file_upload_url_request")).toBe(false);
    expect(isClientToProxyRelayControlType("remote_file_upload_stream_request")).toBe(false);
    expect(isProxyToClientRelayControlType("remote_file_upload_stream_response")).toBe(false);
  });

  it("rejects proxy_select with empty proxyId", () => {
    expect(() => RelayControlSchema.parse({ type: "proxy_select", proxyId: "" })).toThrow();
  });

  it("parses proxy_remove request and success/error responses", () => {
    expect(
      RelayControlSchema.parse({
        type: "proxy_remove",
        requestId: "remove-1",
        proxyId: "proxy-1",
      }),
    ).toEqual({
      type: "proxy_remove",
      requestId: "remove-1",
      proxyId: "proxy-1",
    });

    expect(
      RelayControlSchema.parse({
        type: "proxy_remove_response",
        requestId: "remove-1",
        proxyId: "proxy-1",
        success: true,
      }),
    ).toMatchObject({ success: true, proxyId: "proxy-1" });

    expect(
      RelayControlSchema.parse({
        type: "proxy_remove_response",
        requestId: "remove-2",
        proxyId: "proxy-2",
        success: false,
        errorCode: "PROXY_ONLINE",
        error: "开发机仍在线",
      }),
    ).toMatchObject({
      success: false,
      errorCode: "PROXY_ONLINE",
      error: "开发机仍在线",
    });

    expect(RelayControlSchema.parse({ type: "proxy_removed", proxyId: "proxy-1" })).toEqual({
      type: "proxy_removed",
      proxyId: "proxy-1",
    });
    expect(isProxyToClientRelayControlType("proxy_removed")).toBe(false);
    expect(isProxyToClientRelayControlType("proxy_remove_response")).toBe(false);
    expect(isClientToProxyRelayControlType("proxy_remove")).toBe(false);
    expect(isClientToProxyRelayControlType("proxy_remove_response")).toBe(false);
    expect(isClientToProxyRelayControlType("proxy_removed")).toBe(false);
  });

  it("requires requestId and proxyId when removing a proxy", () => {
    expect(() => RelayControlSchema.parse({ type: "proxy_remove", proxyId: "proxy-1" })).toThrow();
    expect(() =>
      RelayControlSchema.parse({ type: "proxy_remove", requestId: "remove-1" }),
    ).toThrow();
    expect(() =>
      RelayControlSchema.parse({
        type: "proxy_remove",
        requestId: "remove-1",
        proxyId: "",
      }),
    ).toThrow();
  });

  it("rejects client_register with empty clientId", () => {
    expect(() =>
      RelayControlSchema.parse({
        type: "client_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        clientId: "",
        browserName: "test",
        osName: "test",
        deviceKind: "desktop",
      }),
    ).toThrow();
  });

  it("rejects client_register without device descriptor", () => {
    expect(() =>
      RelayControlSchema.parse({
        type: "client_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        clientId: "client-1",
      }),
    ).toThrow();
  });

  it("accepts client_register with required device descriptor and optional browser hints", () => {
    expect(
      RelayControlSchema.parse({
        type: "client_register",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        clientId: "client-1",
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
        browserName: "Safari",
        osName: "iPad",
        deviceKind: "tablet",
      }),
    ).toMatchObject({
      type: "client_register",
      clientId: "client-1",
      platform: "MacIntel",
      maxTouchPoints: 5,
      browserName: "Safari",
      osName: "iPad",
      deviceKind: "tablet",
    });
  });

  it("accepts relay client management messages", () => {
    expect(
      RelayControlSchema.parse({
        type: "relay_client_list_response",
        requestId: "clients-1",
        clients: [
          {
            clientId: "client-1",
            proxyId: "proxy-1",
            connectedAt: 1760000000000,
            current: true,
            userAgent: "Safari",
            platform: "MacIntel",
            maxTouchPoints: 5,
            browserName: "Safari",
            osName: "iPad",
            deviceKind: "tablet",
            remoteAddress: "127.0.0.1",
          },
        ],
      }),
    ).toMatchObject({
      type: "relay_client_list_response",
      clients: [
        {
          clientId: "client-1",
          current: true,
          platform: "MacIntel",
          browserName: "Safari",
          osName: "iPad",
          deviceKind: "tablet",
        },
      ],
    });
    expect(
      RelayControlSchema.parse({
        type: "relay_client_kick",
        requestId: "kick-1",
        clientId: "client-2",
      }),
    ).toMatchObject({ type: "relay_client_kick", clientId: "client-2" });
    expect(isClientToProxyRelayControlType("relay_client_kick")).toBe(false);
    expect(isProxyToClientRelayControlType("relay_client_kicked")).toBe(false);
  });

  it("rejects client_register_response with unknown status", () => {
    expect(() =>
      RelayControlSchema.parse({
        type: "client_register_response",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        status: "invalid",
      }),
    ).toThrow();
  });

  it("requires a connectionId on every successful Proxy registration response", () => {
    expect(
      RelayControlSchema.parse({
        type: "proxy_register_response",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        status: "new",
        relayVersion: "0.9.0",
        connectionId: "connection-1",
      }),
    ).toMatchObject({ status: "new", connectionId: "connection-1" });
    expect(
      RelayControlSchema.safeParse({
        type: "proxy_register_response",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        status: "new",
        connectionId: "connection-1",
      }).success,
    ).toBe(false);
  });

  it("rejects proxy_offline with missing proxyId", () => {
    expect(() => RelayControlSchema.parse({ type: "proxy_offline" })).toThrow();
  });

  it("requires PTY snapshot requestId for exact request routing", () => {
    expect(
      RelayControlSchema.parse({
        type: "session_subscribe",
        sessionId: "sess-1",
        requestId: "pty-snapshot-1",
      }),
    ).toMatchObject({
      type: "session_subscribe",
      requestId: "pty-snapshot-1",
    });
    expect(
      RelayControlSchema.parse({
        type: "session_snapshot",
        sessionId: "sess-1",
        cols: 80,
        rows: 24,
        data: "snapshot",
        outputSeq: 1,
        requestId: "pty-snapshot-1",
      }),
    ).toMatchObject({
      type: "session_snapshot",
      requestId: "pty-snapshot-1",
    });
    expect(
      RelayControlSchema.safeParse({ type: "session_subscribe", sessionId: "sess-1" }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "session_snapshot",
        sessionId: "sess-1",
        cols: 80,
        rows: 24,
        data: "snapshot",
        outputSeq: 1,
      }).success,
    ).toBe(false);
  });

  it("parses turn_result with optional result fallback text", () => {
    const result = RelayControlSchema.parse({
      type: "turn_result",
      sessionId: "sess-json",
      success: true,
      isError: false,
      result: "OK",
    });
    expect(result.type).toBe("turn_result");
    if (result.type === "turn_result") {
      expect(result.result).toBe("OK");
    }
  });

  it("parses paginated session history messages", () => {
    expect(
      RelayControlSchema.parse({
        type: "session_messages_request",
        requestId: "history-1",
        sessionId: "sess-json",
        limit: 50,
        before: "b:2048",
      }),
    ).toMatchObject({
      type: "session_messages_request",
      limit: 50,
      before: "b:2048",
    });

    expect(
      RelayControlSchema.parse({
        type: "session_history_messages",
        requestId: "history-1",
        sessionId: "sess-json",
        before: "b:2048",
        messages: [{ role: "user", text: "older prompt", timestamp: 123, cursor: "b:1024" }],
        hasMore: true,
        nextBefore: "b:1024",
      }),
    ).toMatchObject({
      type: "session_history_messages",
      hasMore: true,
      nextBefore: "b:1024",
    });
  });

  it("parses proxy_list_response with proxies array", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_list_response",
      proxies: [
        { proxyId: "p1", name: "my-laptop", version: "0.9.0", online: true, sessions: [] },
        { proxyId: "p2", version: "0.9.0", online: false, sessions: [] },
      ],
    });
    expect(result.type).toBe("proxy_list_response");
    if (result.type === "proxy_list_response") {
      expect(result.proxies).toHaveLength(2);
      expect(result.proxies[0]).toEqual({
        proxyId: "p1",
        name: "my-laptop",
        version: "0.9.0",
        online: true,
        sessions: [],
      });
      expect(result.proxies[1]).toEqual({
        proxyId: "p2",
        version: "0.9.0",
        online: false,
        sessions: [],
      });
    }
  });

  it("rejects command_list_push without a session id", () => {
    const result = RelayControlSchema.safeParse({
      type: "command_list_push",
      commands: [
        { name: "/compact", description: "Compact history", source: "builtin" },
        { name: "/help", description: "Show help", argumentHint: "[topic]", source: "builtin" },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("parses command_list_push with its session id", () => {
    const result = RelayControlSchema.parse({
      type: "command_list_push",
      sessionId: "session-kimi-1",
      commands: [
        { name: "/init", description: "Initialize", source: "kimi" },
        {
          name: "/compact",
          description: "Compact history",
          argumentHint: "[instructions]",
          source: "kimi",
        },
      ],
    });

    expect(result).toMatchObject({
      type: "command_list_push",
      sessionId: "session-kimi-1",
      commands: [{ name: "/init" }, { name: "/compact", argumentHint: "[instructions]" }],
    });
  });

  it("parses dir_list_response with entries and path", () => {
    const result = RelayControlSchema.parse({
      type: "dir_list_response",
      requestId: "dir-list-1",
      path: "/home/user/project",
      errorCode: "PATH_ACCESS_DENIED",
      error: "permission denied",
      includeHidden: true,
      entries: [
        { name: "src", isDir: true },
        { name: "README.md", isDir: false },
      ],
    });
    expect(result.type).toBe("dir_list_response");
    if (result.type === "dir_list_response") {
      expect(result.path).toBe("/home/user/project");
      expect(result.requestId).toBe("dir-list-1");
      expect(result.errorCode).toBe("PATH_ACCESS_DENIED");
      expect(result.includeHidden).toBe(true);
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual({ name: "src", isDir: true });
    }
  });

  it("requires an explicit hidden-entry policy and rejects forged directory targets", () => {
    expect(
      RelayControlSchema.parse({
        type: "dir_list_request",
        requestId: "dir-list-2",
        path: "/home/user/project",
        includeHidden: false,
      }),
    ).toMatchObject({ type: "dir_list_request", includeHidden: false });

    expect(() =>
      RelayControlSchema.parse({
        type: "dir_list_request",
        requestId: "dir-list-with-forged-proxy",
        proxyId: "other-proxy",
        path: "/home/user/project",
        includeHidden: false,
      }),
    ).toThrow();

    expect(() =>
      RelayControlSchema.parse({
        type: "dir_list_request",
        requestId: "dir-list-3",
        path: "/home/user/project",
      }),
    ).toThrow();

    expect(() =>
      RelayControlSchema.parse({
        type: "dir_list_response",
        requestId: "dir-list-4",
        path: "/home/user/project",
        entries: [],
      }),
    ).toThrow();
  });

  it("parses proxy_info request/response requestId correlation", () => {
    expect(RelayControlSchema.parse({ type: "proxy_info_request", requestId: "info-1" })).toEqual({
      type: "proxy_info_request",
      requestId: "info-1",
    });
    expect(
      RelayControlSchema.parse({
        type: "proxy_info",
        requestId: "info-1",
        homePath: "/home/dev",
        agentCli: {
          claude: { available: true, command: "/usr/local/bin/claude" },
          codex: { available: false, error: "codex not found" },
          kimi: { available: false, error: "kimi not found" },
        },
      }),
    ).toEqual({
      type: "proxy_info",
      requestId: "info-1",
      homePath: "/home/dev",
      agentCli: {
        claude: { available: true, command: "/usr/local/bin/claude" },
        codex: { available: false, error: "codex not found" },
        kimi: { available: false, error: "kimi not found" },
      },
    });

    expect(
      RelayControlSchema.parse({
        type: "proxy_info",
        requestId: "info-kimi",
        homePath: "/home/dev",
        agentCli: {
          claude: { available: true, command: "/usr/local/bin/claude" },
          codex: { available: true, command: "/usr/local/bin/codex" },
          kimi: { available: true, command: "/home/dev/.kimi-code/bin/kimi" },
        },
      }),
    ).toMatchObject({
      type: "proxy_info",
      agentCli: {
        kimi: { available: true, command: "/home/dev/.kimi-code/bin/kimi" },
      },
    });

    expect(
      RelayControlSchema.safeParse({
        type: "proxy_info_request",
        requestId: "removed-refresh",
        refreshPath: true,
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "proxy_info",
        requestId: "removed-capabilities",
        homePath: "/home/dev",
        agentCli: {
          claude: { available: true },
          codex: { available: true },
        },
        webPreview: {
          cloudflared: { available: false },
          cpolar: { available: false },
        },
      }).success,
    ).toBe(false);
  });

  it("parses agent CLI path update request/response", () => {
    expect(
      RelayControlSchema.parse({
        type: "agent_cli_config_update",
        requestId: "agent-cli-1",
        provider: "claude",
        path: "/home/dev/.local/bin/claude",
      }),
    ).toEqual({
      type: "agent_cli_config_update",
      requestId: "agent-cli-1",
      provider: "claude",
      path: "/home/dev/.local/bin/claude",
    });

    expect(
      RelayControlSchema.parse({
        type: "agent_cli_config_update_response",
        requestId: "agent-cli-1",
        provider: "claude",
        agentCli: {
          claude: { available: true, command: "/home/dev/.local/bin/claude" },
          codex: { available: true, command: "/usr/local/bin/codex" },
          kimi: { available: true, command: "/usr/local/bin/kimi" },
        },
      }),
    ).toEqual({
      type: "agent_cli_config_update_response",
      requestId: "agent-cli-1",
      provider: "claude",
      agentCli: {
        claude: { available: true, command: "/home/dev/.local/bin/claude" },
        codex: { available: true, command: "/usr/local/bin/codex" },
        kimi: { available: true, command: "/usr/local/bin/kimi" },
      },
    });

    expect(
      RelayControlSchema.parse({
        type: "agent_cli_config_update",
        requestId: "agent-cli-kimi",
        provider: "kimi",
        path: "/home/dev/.kimi-code/bin/kimi",
      }),
    ).toEqual({
      type: "agent_cli_config_update",
      requestId: "agent-cli-kimi",
      provider: "kimi",
      path: "/home/dev/.kimi-code/bin/kimi",
    });
  });

  it("parses session_history_response with sessions array", () => {
    const result = RelayControlSchema.parse({
      type: "session_history_response",
      requestId: "history-1",
      success: true,
      sessions: [
        {
          id: "s1",
          title: "Fix bug",
          projectDir: "/project",
          updatedAt: 1700000000,
          provider: "claude",
          preferredMode: "json",
        },
      ],
    });
    expect(result.type).toBe("session_history_response");
    if (result.type === "session_history_response") {
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].title).toBe("Fix bug");
      expect(result.sessions[0].preferredMode).toBe("json");
    }
  });

  it("rejects session history messages without a requestId", () => {
    expect(
      RelayControlSchema.safeParse({
        type: "session_history_request",
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "session_history_response",
        success: true,
        sessions: [],
      }).success,
    ).toBe(false);
  });

  it("parses an explicit session_history_response failure", () => {
    const result = RelayControlSchema.parse({
      type: "session_history_response",
      requestId: "history-1",
      success: false,
      sessions: [],
      errorCode: "UNKNOWN",
      error: "历史会话扫描失败",
    });

    expect(result).toMatchObject({
      type: "session_history_response",
      success: false,
      sessions: [],
      errorCode: "UNKNOWN",
    });
  });

  it("parses file_tree_push with grouped entries per directory", () => {
    const result = RelayControlSchema.parse({
      type: "file_tree_push",
      groups: [
        { path: "/project", entries: [{ name: "src", isDir: true }] },
        { path: "/project/src", entries: [{ name: "index.ts", isDir: false }] },
      ],
    });
    expect(result.type).toBe("file_tree_push");
    if (result.type === "file_tree_push") {
      expect(result.groups).toHaveLength(2);
      expect(result.groups[0].path).toBe("/project");
      expect(result.groups[1].entries[0].name).toBe("index.ts");
    }
  });

  it("parses agent_status with permission request context", () => {
    const result = RelayControlSchema.parse({
      type: "agent_status",
      sessionId: "s1",
      payload: {
        provider: "codex",
        phase: "waiting_permission",
        seq: 12,
        updatedAt: 1760000000000,
        toolName: "Bash",
        toolInput: { command: "pwd" },
        permissionRequest: {
          requestId: "req-1",
          toolName: "Bash",
          input: { command: "pwd" },
        },
      },
    });

    expect(result.type).toBe("agent_status");
    if (result.type === "agent_status") {
      expect(result.sessionId).toBe("s1");
      expect(result.payload.provider).toBe("codex");
      expect(result.payload.phase).toBe("waiting_permission");
      expect(result.payload.permissionRequest?.requestId).toBe("req-1");
    }
  });

  it("parses agent_status_request with optional session id", () => {
    expect(RelayControlSchema.parse({ type: "agent_status_request" })).toEqual({
      type: "agent_status_request",
    });
    expect(
      RelayControlSchema.parse({
        type: "agent_status_request",
        requestId: "req-1",
        sessionId: "s1",
      }),
    ).toEqual({
      type: "agent_status_request",
      requestId: "req-1",
      sessionId: "s1",
    });
  });

  it("parses agent_status_response snapshots", () => {
    const result = RelayControlSchema.parse({
      type: "agent_status_response",
      requestId: "req-1",
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

    expect(result.type).toBe("agent_status_response");
    if (result.type === "agent_status_response") {
      expect(result.requestId).toBe("req-1");
      expect(result.statuses[0].payload.phase).toBe("thinking");
    }
  });

  it("parses session resources snapshots", () => {
    const result = RelayControlSchema.parse({
      type: "session_resources_response",
      requestId: "req-1",
      sessionId: "s1",
      commands: [
        {
          name: "/init",
          description: "Initialize",
          source: "builtin",
        },
      ],
      groups: [
        {
          path: "/tmp",
          entries: [{ name: "src", isDir: true }],
        },
      ],
    });

    expect(result.type).toBe("session_resources_response");
    if (result.type === "session_resources_response") {
      expect(result.commands[0].name).toBe("/init");
      expect(result.groups[0].entries[0].name).toBe("src");
    }

    expect(
      RelayControlSchema.safeParse({
        type: "session_resources_request",
        sessionId: "s1",
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "session_resources_response",
        sessionId: "s1",
        commands: [],
        groups: [],
      }).success,
    ).toBe(false);
  });

  it("parses permission delivery and decision result controls", () => {
    expect(
      RelayControlSchema.parse({
        type: "permission_request_delivered",
        sessionId: "s1",
        requestId: "req-1",
      }),
    ).toEqual({
      type: "permission_request_delivered",
      sessionId: "s1",
      requestId: "req-1",
    });

    const result = RelayControlSchema.parse({
      type: "permission_decision_result",
      sessionId: "s1",
      requestId: "req-1",
      outcome: "deny",
      delivered: true,
      message: "No.",
    });
    expect(result.type).toBe("permission_decision_result");
    if (result.type === "permission_decision_result") {
      expect(result.outcome).toBe("deny");
      expect(result.delivered).toBe(true);
      expect(result.message).toBe("No.");
    }
  });

  it("rejects agent_status with invalid phase", () => {
    expect(() =>
      RelayControlSchema.parse({
        type: "agent_status",
        sessionId: "s1",
        payload: {
          provider: "claude",
          phase: "busy",
          seq: 1,
          updatedAt: 1760000000000,
        },
      }),
    ).toThrow();
  });

  it("parses proxy_select_response with success=true and its new bindingId", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_select_response",
      success: true,
      proxyId: "p1",
      bindingId: "binding-1",
    });
    expect(result.type).toBe("proxy_select_response");
    if (result.type === "proxy_select_response" && result.success) {
      expect(result.success).toBe(true);
      expect(result.proxyId).toBe("p1");
      expect(result.bindingId).toBe("binding-1");
    }
  });

  it("parses restored client registration and stale-binding errors", () => {
    expect(
      RelayControlSchema.parse({
        type: "client_register_response",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        status: "restored",
        proxyId: "p1",
        bindingId: "binding-2",
      }),
    ).toMatchObject({ proxyId: "p1", bindingId: "binding-2" });
    expect(
      RelayControlSchema.parse({
        type: "relay_error",
        requestId: "preview-list-1",
        code: "STALE_BINDING",
        message: "Preview request used a stale client binding",
      }),
    ).toMatchObject({ requestId: "preview-list-1", code: "STALE_BINDING" });
  });

  it("parses proxy_select_response with success=false and error", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_select_response",
      success: false,
      errorCode: "PROXY_OFFLINE",
      error: "Proxy not online: p1",
    });
    expect(result.type).toBe("proxy_select_response");
    if (result.type === "proxy_select_response" && !result.success) {
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("PROXY_OFFLINE");
      expect(result.error).toBe("Proxy not online: p1");
    }
  });

  it("rejects incomplete or mixed proxy selection response branches", () => {
    expect(
      RelayControlSchema.safeParse({
        type: "proxy_select_response",
        success: true,
        proxyId: "p1",
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "proxy_select_response",
        success: true,
        bindingId: "binding-1",
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "proxy_select_response",
        success: false,
        proxyId: "p1",
        bindingId: "binding-1",
      }).success,
    ).toBe(false);
  });

  it("rejects incomplete or mixed client registration response branches", () => {
    for (const status of ["restored", "proxy_offline"] as const) {
      expect(
        RelayControlSchema.safeParse({
          type: "client_register_response",
          protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
          status,
          proxyId: "p1",
        }).success,
      ).toBe(false);
      expect(
        RelayControlSchema.safeParse({
          type: "client_register_response",
          protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
          status,
          bindingId: "binding-1",
        }).success,
      ).toBe(false);
    }
    expect(
      RelayControlSchema.safeParse({
        type: "client_register_response",
        protocolVersion: RELAY_CONTROL_PROTOCOL_VERSION,
        status: "new",
        proxyId: "p1",
        bindingId: "binding-1",
      }).success,
    ).toBe(false);
  });

  it("parses proxy_list_response with sessions field in ProxyInfo", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_list_response",
      proxies: [
        { proxyId: "p1", version: "0.9.0", online: true, sessions: ["s1", "s2"] },
        { proxyId: "p2", version: "0.9.0", online: false, sessions: [] },
      ],
    });
    expect(result.type).toBe("proxy_list_response");
    if (result.type === "proxy_list_response") {
      expect(result.proxies[0].sessions).toEqual(["s1", "s2"]);
      expect(result.proxies[1].sessions).toEqual([]);
    }
  });

  it("rejects proxy_list_response entries without sessions", () => {
    expect(
      RelayControlSchema.safeParse({
        type: "proxy_list_response",
        proxies: [{ proxyId: "p1", version: "0.9.0", online: true }],
      }).success,
    ).toBe(false);
  });

  it("accepts agent and terminal session_create", () => {
    const result = RelayControlSchema.parse({
      type: "session_create",
      requestId: "create-agent",
      kind: "agent",
      cwd: "/tmp/project",
      provider: "claude",
      mode: "pty",
      permissionMode: "default",
      cols: 125,
      rows: 34,
    });
    expect(result.type).toBe("session_create");
    if (result.type === "session_create" && result.kind === "agent" && result.mode === "pty") {
      expect(result.kind).toBe("agent");
      expect(result.provider).toBe("claude");
      expect(result.mode).toBe("pty");
      expect(result.cols).toBe(125);
      expect(result.rows).toBe(34);
    }

    const terminal = RelayControlSchema.parse({
      type: "session_create",
      requestId: "create-terminal",
      kind: "terminal",
      mode: "pty",
      cols: 80,
      rows: 30,
    });
    expect(terminal.type).toBe("session_create");
    if (terminal.type === "session_create" && terminal.kind === "terminal") {
      expect(terminal.kind).toBe("terminal");
      expect("cwd" in terminal).toBe(false);
      expect("provider" in terminal).toBe(false);
      expect(terminal.cols).toBe(80);
      expect(terminal.rows).toBe(30);
    }
  });

  it("rejects PTY session creation without complete initial geometry", () => {
    expect(
      RelayControlSchema.safeParse({
        type: "session_create",
        requestId: "create-agent",
        kind: "agent",
        cwd: "/tmp/project",
        provider: "claude",
        mode: "pty",
        rows: 24,
      }).success,
    ).toBe(false);
    expect(
      RelayControlSchema.safeParse({
        type: "session_create",
        requestId: "create-terminal",
        kind: "terminal",
        mode: "pty",
        cols: 80,
      }).success,
    ).toBe(false);
  });

  it("rejects incomplete session creation messages", () => {
    const complete = {
      type: "session_create",
      requestId: "create-agent",
      kind: "agent",
      cwd: "/tmp/project",
      provider: "claude",
      mode: "json",
    } as const;
    for (const field of ["requestId", "kind", "cwd", "provider", "mode"] as const) {
      const message = { ...complete } as Record<string, unknown>;
      delete message[field];
      expect(RelayControlSchema.safeParse(message).success).toBe(false);
    }

    expect(
      RelayControlSchema.safeParse({
        type: "session_create_response",
        requestId: "create-agent",
        success: true,
        sessionId: "session-1",
        kind: "agent",
        mode: "json",
      }).success,
    ).toBe(false);

    const completeResponse = {
      type: "session_create_response",
      requestId: "create-agent",
      success: true,
      sessionId: "session-1",
      cwd: "/tmp/project",
      lastActive: 1,
      kind: "agent",
      mode: "json",
      provider: "claude",
    } as const;
    expect(RelayControlSchema.safeParse(completeResponse).success).toBe(true);
    for (const field of ["cwd", "lastActive"] as const) {
      const response = { ...completeResponse } as Record<string, unknown>;
      delete response[field];
      expect(RelayControlSchema.safeParse(response).success).toBe(false);
    }
  });

  it("requires every synchronized session to declare a legal identity", () => {
    expect(
      RelayControlSchema.safeParse({
        type: "session_sync",
        sessions: [
          {
            id: "session-1",
            kind: "agent",
            mode: "json",
            provider: "claude",
            cwd: "/tmp/test",
            state: "idle",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      RelayControlSchema.safeParse({
        type: "session_sync",
        sessions: [
          {
            id: "session-1",
            mode: "json",
            provider: "claude",
            cwd: "/tmp/test",
            state: "idle",
          },
        ],
      }).success,
    ).toBe(false);

    for (const session of [
      {
        id: "pty-no-owner",
        kind: "agent",
        mode: "pty",
        provider: "claude",
        cwd: "/tmp/test",
        state: "idle",
      },
      {
        id: "json-with-owner",
        kind: "agent",
        mode: "json",
        provider: "claude",
        ptyOwner: "local-terminal",
        cwd: "/tmp/test",
        state: "idle",
      },
      {
        id: "terminal-wrong-owner",
        kind: "terminal",
        mode: "pty",
        provider: "claude",
        ptyOwner: "proxy-hosted",
        cwd: "/tmp/test",
        state: "idle",
      },
    ]) {
      expect(
        RelayControlSchema.safeParse({ type: "session_sync", sessions: [session] }).success,
      ).toBe(false);
    }

    expect(
      RelayControlSchema.safeParse({
        type: "session_sync",
        sessions: [
          { id: "missing-cwd", kind: "agent", mode: "json", provider: "claude", state: "idle" },
        ],
      }).success,
    ).toBe(false);
  });

  it("routes terminal_resize_request from client to proxy", () => {
    const result = RelayControlSchema.parse({
      type: "terminal_resize_request",
      sessionId: "s1",
      cols: 100,
      rows: 30,
    });
    expect(result.type).toBe("terminal_resize_request");
    expect(ClientToProxyRelayControlTypes.has("terminal_resize_request")).toBe(true);
    expect(ProxyToClientRelayControlTypes.has("terminal_resize_request")).toBe(false);
  });

  it("requires an ordered render sequence on terminal resize events", () => {
    const result = RelayControlSchema.parse({
      type: "terminal_resize",
      sessionId: "s1",
      cols: 100,
      rows: 30,
      outputSeq: 42,
    });

    expect(result).toMatchObject({ type: "terminal_resize", outputSeq: 42 });
    expect(ProxyToClientRelayControlTypes.has("terminal_resize")).toBe(true);
    expect(
      RelayControlSchema.safeParse({
        type: "terminal_resize",
        sessionId: "s1",
        cols: 100,
        rows: 30,
      }).success,
    ).toBe(false);
  });

  it("parses latency probe controls and keeps relay-local probes out of forwarding sets", () => {
    expect(
      RelayControlSchema.parse({ type: "latency_web_relay_ping", requestId: "latency-1" }),
    ).toEqual({ type: "latency_web_relay_ping", requestId: "latency-1" });
    expect(
      RelayControlSchema.parse({
        type: "latency_relay_proxy_response",
        requestId: "latency-2",
        success: true,
        rttMs: 42,
      }),
    ).toMatchObject({ type: "latency_relay_proxy_response", success: true, rttMs: 42 });

    expect(isClientToProxyRelayControlType("latency_web_proxy_ping")).toBe(true);
    expect(isProxyToClientRelayControlType("latency_web_proxy_pong")).toBe(true);
    expect(isClientToProxyRelayControlType("latency_relay_proxy_request")).toBe(false);
    expect(isClientToProxyRelayControlType("latency_relay_proxy_ping")).toBe(false);
    expect(isProxyToClientRelayControlType("latency_relay_proxy_response")).toBe(false);
    expect(isProxyToClientRelayControlType("latency_relay_proxy_pong")).toBe(false);
  });
});
