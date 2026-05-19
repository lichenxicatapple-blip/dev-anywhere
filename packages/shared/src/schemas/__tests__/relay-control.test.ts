import { describe, it, expect } from "vitest";
import {
  ClientToProxyRelayControlTypes,
  isClientToProxyRelayControlType,
  isProxyToClientRelayControlType,
  ProxyToClientRelayControlTypes,
  RelayControlSchema,
} from "../relay-control.js";

describe("RelayControlSchema", () => {
  it("rejects proxy_register with empty proxyId", () => {
    expect(() => RelayControlSchema.parse({ type: "proxy_register", proxyId: "" })).toThrow();
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
    expect(isClientToProxyRelayControlType("clipboard_image_upload")).toBe(true);
    expect(isClientToProxyRelayControlType("permission_request_delivered")).toBe(true);
    expect(isClientToProxyRelayControlType("tool_approve")).toBe(true);
    expect(isClientToProxyRelayControlType("tool_deny")).toBe(true);
    expect(isClientToProxyRelayControlType("session_resources_request")).toBe(true);
    expect(isClientToProxyRelayControlType("session_rename")).toBe(true);
    expect(isClientToProxyRelayControlType("session_list")).toBe(true);
    expect(isClientToProxyRelayControlType("voice_summary_request")).toBe(true);
    expect(isClientToProxyRelayControlType("agent_status")).toBe(false);
    expect(isClientToProxyRelayControlType("permission_decision_result")).toBe(false);
    expect(isClientToProxyRelayControlType("voice_config_request")).toBe(false);
    expect(isClientToProxyRelayControlType("voice_capabilities_request")).toBe(false);
    expect(ClientToProxyRelayControlTypes.has("dir_list_response")).toBe(false);
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

  it("parses clipboard image upload request/response with requestId correlation", () => {
    expect(
      RelayControlSchema.parse({
        type: "clipboard_image_upload",
        requestId: "clip-1",
        sessionId: "sess-1",
        mimeType: "image/png",
        dataBase64: "AQID",
        fileName: "shot.png",
      }),
    ).toEqual({
      type: "clipboard_image_upload",
      requestId: "clip-1",
      sessionId: "sess-1",
      mimeType: "image/png",
      dataBase64: "AQID",
      fileName: "shot.png",
    });

    expect(
      RelayControlSchema.parse({
        type: "clipboard_image_upload_response",
        requestId: "clip-1",
        sessionId: "sess-1",
        success: true,
        path: ".dev-anywhere/clipboard/sess-1/shot.png",
      }),
    ).toMatchObject({
      type: "clipboard_image_upload_response",
      requestId: "clip-1",
      sessionId: "sess-1",
      success: true,
    });
    expect(isProxyToClientRelayControlType("clipboard_image_upload_response")).toBe(true);
  });

  it("parses image preview request/response with requestId correlation", () => {
    expect(
      RelayControlSchema.parse({
        type: "image_preview_request",
        requestId: "preview-1",
        sessionId: "sess-1",
        path: ".dev-anywhere/clipboard/sess-1/shot.png",
      }),
    ).toEqual({
      type: "image_preview_request",
      requestId: "preview-1",
      sessionId: "sess-1",
      path: ".dev-anywhere/clipboard/sess-1/shot.png",
    });

    expect(
      RelayControlSchema.parse({
        type: "image_preview_response",
        requestId: "preview-1",
        sessionId: "sess-1",
        success: true,
        path: ".dev-anywhere/clipboard/sess-1/shot.png",
        mimeType: "image/png",
        dataBase64: "AQID",
        size: 3,
      }),
    ).toMatchObject({
      type: "image_preview_response",
      requestId: "preview-1",
      sessionId: "sess-1",
      success: true,
      mimeType: "image/png",
    });
    expect(isClientToProxyRelayControlType("image_preview_request")).toBe(true);
    expect(isProxyToClientRelayControlType("image_preview_response")).toBe(true);
  });

  it("rejects proxy_select with empty proxyId", () => {
    expect(() => RelayControlSchema.parse({ type: "proxy_select", proxyId: "" })).toThrow();
  });

  it("rejects client_register with empty clientId", () => {
    expect(() => RelayControlSchema.parse({ type: "client_register", clientId: "" })).toThrow();
  });

  it("rejects client_register_response with unknown status", () => {
    expect(() =>
      RelayControlSchema.parse({ type: "client_register_response", status: "invalid" }),
    ).toThrow();
  });

  it("rejects proxy_offline with missing proxyId", () => {
    expect(() => RelayControlSchema.parse({ type: "proxy_offline" })).toThrow();
  });

  it("accepts PTY snapshot requestId for stale snapshot rejection", () => {
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
        { proxyId: "p1", name: "my-laptop", online: true },
        { proxyId: "p2", online: false },
      ],
    });
    expect(result.type).toBe("proxy_list_response");
    if (result.type === "proxy_list_response") {
      expect(result.proxies).toHaveLength(2);
      expect(result.proxies[0]).toEqual({ proxyId: "p1", name: "my-laptop", online: true });
      expect(result.proxies[1]).toEqual({ proxyId: "p2", online: false });
    }
  });

  it("parses command_list_push with commands array", () => {
    const result = RelayControlSchema.parse({
      type: "command_list_push",
      commands: [
        { name: "/compact", description: "Compact history", source: "builtin" },
        { name: "/help", description: "Show help", argumentHint: "[topic]", source: "builtin" },
      ],
    });
    expect(result.type).toBe("command_list_push");
    if (result.type === "command_list_push") {
      expect(result.commands).toHaveLength(2);
      expect(result.commands[0].argumentHint).toBeUndefined();
      expect(result.commands[1].argumentHint).toBe("[topic]");
    }
  });

  it("parses dir_list_response with entries and path", () => {
    const result = RelayControlSchema.parse({
      type: "dir_list_response",
      requestId: "dir-list-1",
      path: "/home/user/project",
      errorCode: "PATH_ACCESS_DENIED",
      error: "permission denied",
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
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]).toEqual({ name: "src", isDir: true });
    }
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
        },
      }),
    ).toEqual({
      type: "proxy_info",
      requestId: "info-1",
      homePath: "/home/dev",
      agentCli: {
        claude: { available: true, command: "/usr/local/bin/claude" },
        codex: { available: false, error: "codex not found" },
      },
    });
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
        },
      }),
    ).toEqual({
      type: "agent_cli_config_update_response",
      requestId: "agent-cli-1",
      provider: "claude",
      agentCli: {
        claude: { available: true, command: "/home/dev/.local/bin/claude" },
        codex: { available: true, command: "/usr/local/bin/codex" },
      },
    });
  });

  it("parses session_history_response with sessions array", () => {
    const result = RelayControlSchema.parse({
      type: "session_history_response",
      sessions: [{ id: "s1", title: "Fix bug", projectDir: "/project", updatedAt: 1700000000 }],
    });
    expect(result.type).toBe("session_history_response");
    if (result.type === "session_history_response") {
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].title).toBe("Fix bug");
    }
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

  it("parses proxy_select_response with success=true and proxyId", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_select_response",
      success: true,
      proxyId: "p1",
    });
    expect(result.type).toBe("proxy_select_response");
    if (result.type === "proxy_select_response") {
      expect(result.success).toBe(true);
      expect(result.proxyId).toBe("p1");
    }
  });

  it("parses proxy_select_response with success=false and error", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_select_response",
      success: false,
      errorCode: "PROXY_OFFLINE",
      error: "Proxy not online: p1",
    });
    expect(result.type).toBe("proxy_select_response");
    if (result.type === "proxy_select_response") {
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("PROXY_OFFLINE");
      expect(result.error).toBe("Proxy not online: p1");
    }
  });

  it("parses proxy_list_response with sessions field in ProxyInfo", () => {
    const result = RelayControlSchema.parse({
      type: "proxy_list_response",
      proxies: [
        { proxyId: "p1", online: true, sessions: ["s1", "s2"] },
        { proxyId: "p2", online: false },
      ],
    });
    expect(result.type).toBe("proxy_list_response");
    if (result.type === "proxy_list_response") {
      expect(result.proxies[0].sessions).toEqual(["s1", "s2"]);
      expect(result.proxies[1].sessions).toBeUndefined();
    }
  });

  it("requires provider on session_create", () => {
    const result = RelayControlSchema.parse({
      type: "session_create",
      cwd: "/tmp/project",
      provider: "claude",
      mode: "pty",
      permissionMode: "default",
    });
    expect(result.type).toBe("session_create");
    if (result.type === "session_create") {
      expect(result.provider).toBe("claude");
      expect(result.mode).toBe("pty");
    }

    expect(() =>
      RelayControlSchema.parse({
        type: "session_create",
        cwd: "/tmp/project",
      }),
    ).toThrow();
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
});
