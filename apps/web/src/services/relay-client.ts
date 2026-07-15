// Relay 协议客户端，处理注册、代理选择、消息发送和控制消息路由
import type { WebSocketManager } from "@/services/websocket";
import type {
  AgentStatusPayload,
  AgentCliStatus,
  CommandEntry,
  ControlErrorCodeType,
  DirEntry,
  FileTreeGroup,
  HistorySession,
  MessageEnvelope,
  RelayClientInfo,
  RelayControlMessage,
  VoiceConfigUpdate,
  VoiceCapabilities,
  VoiceProviderConfig,
  VoiceSummaryReason,
} from "@dev-anywhere/shared";
import { SESSION_CREATE_CLIENT_TIMEOUT_MS } from "@dev-anywhere/shared";
import { describeCurrentClientDevice } from "@/lib/client-device";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const VOICE_SUMMARY_REQUEST_TIMEOUT_MS = 20_000;
const LATENCY_PROBE_TIMEOUT_MS = 3_000;

export type InboundMessage = MessageEnvelope | RelayControlMessage;
type ProxyInfoResult = Array<{
  proxyId: string;
  name?: string;
  online: boolean;
  sessions?: string[];
}>;
type RelayClientListResult = RelayClientInfo[];
type RelayClientKickResponse = Extract<RelayControlMessage, { type: "relay_client_kick_response" }>;
type RelayClientKickResult = {
  clientId: string;
  success: boolean;
} & RequestError;
type SessionHistoryMessage = Extract<
  RelayControlMessage,
  { type: "session_history_messages" }
>["messages"][number];
type SessionHistoryPage = {
  messages: SessionHistoryMessage[];
  hasMore: boolean;
  nextBefore?: string;
  before?: string;
};
type AgentStatusSnapshot = Array<{ sessionId: string; payload: AgentStatusPayload }>;
type SessionResourcesSnapshot = {
  sessionId: string;
  commands: CommandEntry[];
  groups: FileTreeGroup[];
} & RequestError;
type RemoteFileUrlResponse = Extract<RelayControlMessage, { type: "remote_file_url_response" }>;
type RemoteFileDisposition = Extract<
  RelayControlMessage,
  { type: "remote_file_url_request" }
>["disposition"];
type RemoteFileUploadUrlResponse = Extract<
  RelayControlMessage,
  { type: "remote_file_upload_url_response" }
>;
type RemoteFileUploadKind = Extract<
  RelayControlMessage,
  { type: "remote_file_upload_url_request" }
>["kind"];
type RemoteFileUrlResult = {
  sessionId: string;
  success: boolean;
  path?: string;
  url?: string;
  expiresAt?: number;
} & RequestError;
type FileUploadResult = {
  sessionId: string;
  success: boolean;
  path?: string;
} & RequestError;

type RelayTransport = Pick<WebSocketManager, "onMessage" | "onStatusChange" | "send">;
type SessionCreateRequest = Extract<RelayControlMessage, { type: "session_create" }>;
type SessionCreateResponse = Extract<RelayControlMessage, { type: "session_create_response" }>;
type SessionRenameResponse = Extract<RelayControlMessage, { type: "session_rename_response" }>;
type SessionRenameResult = {
  sessionId: string;
  success: boolean;
  name?: string;
} & RequestError;
type VoiceConfigResponse = Extract<RelayControlMessage, { type: "voice_config_response" }>;
type VoiceConfigResult = {
  config?: VoiceProviderConfig;
} & RequestError;
type VoiceConfigUpdateResponse = Extract<
  RelayControlMessage,
  { type: "voice_config_update_response" }
>;
type VoiceConfigUpdateResult = {
  success: boolean;
  config?: VoiceProviderConfig;
} & RequestError;
type VoiceConfigTestResponse = Extract<RelayControlMessage, { type: "voice_config_test_response" }>;
type VoiceConfigTestResult = {
  success: boolean;
  audioBase64?: string;
  audioSampleRate?: number;
  audioEncoding?: "pcm_s16le";
  transcript?: string;
} & RequestError;
type VoiceCapabilitiesResponse = Extract<
  RelayControlMessage,
  { type: "voice_capabilities_response" }
>;
type VoiceCapabilitiesResult = {
  capabilities?: VoiceCapabilities;
} & RequestError;
type VoiceSummaryResponse = Extract<RelayControlMessage, { type: "voice_summary_response" }>;
type VoiceSummaryResult = {
  sessionId: string;
  messageId: string;
  success: boolean;
  summary?: string;
} & RequestError;
export type LatencyProbeResult = {
  success: boolean;
  rttMs?: number;
  error?: string;
};
type RequestError = { error?: string; errorCode?: ControlErrorCodeType };

let requestSeq = 0;

function nextRequestId(prefix: string): string {
  requestSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${requestSeq.toString(36)}`;
}

export class RelayClient {
  private ws: RelayTransport;
  private clientId: string;
  private boundProxyId: string | null = null;
  private messageHandlers = new Set<(msg: InboundMessage) => void>();
  private pendingMessages: InboundMessage[] = [];

  constructor(ws: RelayTransport, clientId: string) {
    this.ws = ws;
    this.clientId = clientId;

    // 只注册一次 ws listener，收到消息后分发给所有 handler
    // handler 未注册时先缓冲，等 onMessage 注册后 flush
    this.ws.onMessage((raw) => {
      let parsed: InboundMessage;
      try {
        parsed = JSON.parse(raw) as MessageEnvelope | RelayControlMessage;
      } catch (e) {
        console.warn("RelayClient: failed to parse JSON:", raw.slice(0, 200), e);
        return;
      }
      if (this.messageHandlers.size === 0) {
        this.pendingMessages.push(parsed);
        return;
      }
      this.dispatch(parsed);
    });
  }

  private dispatch(msg: InboundMessage): void {
    this.messageHandlers.forEach((h) => {
      try {
        h(msg);
      } catch (e) {
        console.warn("RelayClient: message handler error:", (msg as { type?: string }).type, e);
      }
    });
  }

  // 发送 client_register，携带 clientId 和设备描述，便于客户端管理识别设备。
  // 注册意味着新连接，旧绑定对新 relay 实例无效
  register(): void {
    this.boundProxyId = null;
    const clientDevice = describeCurrentClientDevice();
    this.ws.send(
      JSON.stringify({
        type: "client_register",
        clientId: this.clientId,
        ...clientDevice,
      }),
    );
  }

  // 请求可用代理列表（fire-and-forget，响应通过 onMessage 处理）
  listProxies(): void {
    this.ws.send(JSON.stringify({ type: "proxy_list_request" }));
  }

  // 请求代理列表并返回 Promise，等待 proxy_list_response 响应
  requestProxyList(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<ProxyInfoResult> {
    const requestId = nextRequestId("proxy-list");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "proxy_list_response" }> =>
        msg.type === "proxy_list_response" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "proxy_list_request", requestId })),
      "请求开发机列表超时",
      timeoutMs,
      requestId,
    ).then((msg) => msg.proxies as ProxyInfoResult);
  }

  requestRelayClients(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<RelayClientListResult> {
    const requestId = nextRequestId("relay-clients");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "relay_client_list_response" }> =>
        msg.type === "relay_client_list_response" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "relay_client_list_request", requestId })),
      "读取客户端列表超时",
      timeoutMs,
      requestId,
    ).then((msg) => msg.clients);
  }

  kickRelayClient(
    clientId: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<RelayClientKickResult> {
    const requestId = nextRequestId("relay-client-kick");
    return this.waitForMessage(
      (msg): msg is RelayClientKickResponse =>
        msg.type === "relay_client_kick_response" && msg.requestId === requestId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "relay_client_kick",
            requestId,
            clientId,
          }),
        ),
      "断开客户端超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      clientId: resp.clientId,
      success: resp.success,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  // 选择并绑定一个代理，返回 Promise 等待 proxy_select_response ACK
  selectProxy(
    proxyId: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<{ success: boolean; proxyId?: string } & RequestError> {
    const requestId = nextRequestId("proxy-select");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "proxy_select_response" }> =>
        msg.type === "proxy_select_response" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "proxy_select", requestId, proxyId })),
      "连接开发机超时",
      timeoutMs,
      requestId,
    ).then((resp) => {
      if (resp.success) {
        this.boundProxyId = proxyId;
      }
      return {
        success: resp.success,
        proxyId: resp.proxyId,
        error: resp.error,
        errorCode: resp.errorCode,
      };
    });
  }

  createDirectory(
    path: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<{ success: boolean; path: string } & RequestError> {
    const requestId = nextRequestId("dir-create");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "dir_create_response" }> =>
        msg.type === "dir_create_response" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "dir_create_request", requestId, path })),
      "创建目录超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      success: resp.success,
      path: resp.path,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  requestDirectoryList(
    path: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<{ path: string; entries: DirEntry[] } & RequestError> {
    const requestId = nextRequestId("dir-list");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "dir_list_response" }> =>
        msg.type === "dir_list_response" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "dir_list_request", requestId, path })),
      "读取目录超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      path: resp.path,
      entries: resp.entries,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  uploadClipboardImage(sessionId: string, file: File): Promise<FileUploadResult> {
    return this.uploadRemoteFile(sessionId, file, "clipboard_image");
  }

  requestRemoteFileUrl(
    sessionId: string,
    path: string,
    disposition: RemoteFileDisposition,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<RemoteFileUrlResult> {
    const requestId = nextRequestId("remote-file-url");
    return this.waitForMessage(
      (msg): msg is RemoteFileUrlResponse =>
        msg.type === "remote_file_url_response" &&
        msg.requestId === requestId &&
        msg.sessionId === sessionId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "remote_file_url_request",
            requestId,
            sessionId,
            path,
            disposition,
          }),
        ),
      "读取文件地址超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      sessionId: resp.sessionId,
      success: resp.success,
      path: resp.path,
      url: resp.url,
      expiresAt: resp.expiresAt,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  uploadFile(sessionId: string, file: File): Promise<FileUploadResult> {
    return this.uploadRemoteFile(sessionId, file, "file");
  }

  private requestRemoteFileUploadUrl(
    sessionId: string,
    file: File,
    kind: RemoteFileUploadKind,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<RemoteFileUploadUrlResponse> {
    const requestId = nextRequestId("remote-file-upload-url");
    return this.waitForMessage(
      (msg): msg is RemoteFileUploadUrlResponse =>
        msg.type === "remote_file_upload_url_response" &&
        msg.requestId === requestId &&
        msg.sessionId === sessionId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "remote_file_upload_url_request",
            requestId,
            sessionId,
            kind,
            fileName: file.name || "upload",
            mimeType: file.type || "application/octet-stream",
            size: file.size,
          }),
        ),
      "创建上传地址超时",
      timeoutMs,
      requestId,
    );
  }

  private async uploadRemoteFile(
    sessionId: string,
    file: File,
    kind: RemoteFileUploadKind,
  ): Promise<FileUploadResult> {
    const urlResp = await this.requestRemoteFileUploadUrl(sessionId, file, kind);
    if (!urlResp.success || !urlResp.uploadUrl) {
      return {
        sessionId: urlResp.sessionId,
        success: false,
        error: urlResp.error ?? "创建上传地址失败",
        errorCode: urlResp.errorCode,
      };
    }

    const resp = await fetch(urlResp.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    });
    const body = (await resp.json().catch(() => ({}))) as FileUploadResult;
    if (!resp.ok) {
      return {
        sessionId,
        success: false,
        error: body.error ?? "上传失败",
        errorCode: body.errorCode,
      };
    }
    return {
      sessionId: body.sessionId ?? sessionId,
      success: body.success,
      path: body.path,
      error: body.error,
      errorCode: body.errorCode,
    };
  }

  requestProxyInfo(
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<{ homePath: string; agentCli: AgentCliStatus }> {
    const requestId = nextRequestId("proxy-info");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "proxy_info" }> =>
        msg.type === "proxy_info" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "proxy_info_request", requestId })),
      "读取开发机信息超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({ homePath: resp.homePath, agentCli: resp.agentCli }));
  }

  updateAgentCliPath(
    provider: "claude" | "codex",
    path: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<{ provider: "claude" | "codex"; agentCli?: AgentCliStatus } & RequestError> {
    const requestId = nextRequestId("agent-cli-config");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "agent_cli_config_update_response" }> =>
        msg.type === "agent_cli_config_update_response" && msg.requestId === requestId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "agent_cli_config_update",
            requestId,
            provider,
            path,
          }),
        ),
      "保存 Agent CLI 路径超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      provider: resp.provider,
      agentCli: resp.agentCli,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  requestVoiceConfig(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<VoiceConfigResult> {
    const requestId = nextRequestId("voice-config");
    return this.waitForMessage(
      (msg): msg is VoiceConfigResponse =>
        msg.type === "voice_config_response" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "voice_config_request", requestId })),
      "读取语音设置超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      config: resp.config,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  updateVoiceConfig(
    config: VoiceConfigUpdate,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<VoiceConfigUpdateResult> {
    const requestId = nextRequestId("voice-config-update");
    return this.waitForMessage(
      (msg): msg is VoiceConfigUpdateResponse =>
        msg.type === "voice_config_update_response" && msg.requestId === requestId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "voice_config_update",
            requestId,
            config,
          }),
        ),
      "保存语音设置超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      success: resp.success,
      config: resp.config,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  testVoiceConfig(
    config: VoiceConfigUpdate = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<VoiceConfigTestResult> {
    const requestId = nextRequestId("voice-config-test");
    return this.waitForMessage(
      (msg): msg is VoiceConfigTestResponse =>
        msg.type === "voice_config_test_response" && msg.requestId === requestId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "voice_config_test",
            requestId,
            config,
          }),
        ),
      "测试语音配置超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      success: resp.success,
      audioBase64: resp.audioBase64,
      audioSampleRate: resp.audioSampleRate,
      audioEncoding: resp.audioEncoding,
      transcript: resp.transcript,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  requestVoiceCapabilities(
    options: { region?: VoiceProviderConfig["region"] } = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<VoiceCapabilitiesResult> {
    const requestId = nextRequestId("voice-capabilities");
    return this.waitForMessage(
      (msg): msg is VoiceCapabilitiesResponse =>
        msg.type === "voice_capabilities_response" && msg.requestId === requestId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "voice_capabilities_request",
            requestId,
            ...(options.region ? { region: options.region } : {}),
          }),
        ),
      "读取语音能力列表超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      capabilities: resp.capabilities,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  requestVoiceSummary(
    sessionId: string,
    messageId: string,
    text: string,
    reason: VoiceSummaryReason,
    timeoutMs = VOICE_SUMMARY_REQUEST_TIMEOUT_MS,
  ): Promise<VoiceSummaryResult> {
    const requestId = nextRequestId("voice-summary");
    return this.waitForMessage(
      (msg): msg is VoiceSummaryResponse =>
        msg.type === "voice_summary_response" &&
        msg.requestId === requestId &&
        msg.sessionId === sessionId &&
        msg.messageId === messageId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "voice_summary_request",
            requestId,
            sessionId,
            messageId,
            text,
            reason,
          }),
        ),
      "生成语音摘要超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      sessionId: resp.sessionId,
      messageId: resp.messageId,
      success: resp.success,
      summary: resp.summary,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  measureWebRelayLatency(timeoutMs = LATENCY_PROBE_TIMEOUT_MS): Promise<LatencyProbeResult> {
    const requestId = nextRequestId("latency-web-relay");
    const startedAt = performance.now();
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "latency_web_relay_pong" }> =>
        msg.type === "latency_web_relay_pong" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "latency_web_relay_ping", requestId })),
      "Web 到 Relay 服务器测速超时",
      timeoutMs,
      requestId,
    ).then(() => ({
      success: true,
      rttMs: performance.now() - startedAt,
    }));
  }

  measureRelayProxyLatency(timeoutMs = LATENCY_PROBE_TIMEOUT_MS): Promise<LatencyProbeResult> {
    const requestId = nextRequestId("latency-relay-proxy");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "latency_relay_proxy_response" }> =>
        msg.type === "latency_relay_proxy_response" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "latency_relay_proxy_request", requestId })),
      "Relay 服务器到开发机测速超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      success: resp.success,
      rttMs: resp.rttMs,
      error: resp.error,
    }));
  }

  measureWebProxyLatency(timeoutMs = LATENCY_PROBE_TIMEOUT_MS): Promise<LatencyProbeResult> {
    const requestId = nextRequestId("latency-web-proxy");
    const startedAt = performance.now();
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "latency_web_proxy_pong" }> =>
        msg.type === "latency_web_proxy_pong" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "latency_web_proxy_ping", requestId })),
      "Web 到开发机测速超时",
      timeoutMs,
      requestId,
    ).then(() => ({
      success: true,
      rttMs: performance.now() - startedAt,
    }));
  }

  requestSessionHistory(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<HistorySession[]> {
    const requestId = nextRequestId("session-history");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "session_history_response" }> =>
        msg.type === "session_history_response" && msg.requestId === requestId,
      () => this.ws.send(JSON.stringify({ type: "session_history_request", requestId })),
      "读取历史会话超时",
      timeoutMs,
      requestId,
    ).then((resp) => resp.sessions);
  }

  requestSessionMessages(
    sessionId: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<SessionHistoryMessage[]> {
    return this.requestSessionMessagesPage(sessionId, {}, timeoutMs).then((resp) => resp.messages);
  }

  requestSessionMessagesPage(
    sessionId: string,
    options: { limit?: number; before?: string } = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<SessionHistoryPage> {
    const requestId = nextRequestId("session-messages");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "session_history_messages" }> =>
        msg.type === "session_history_messages" &&
        msg.requestId === requestId &&
        msg.sessionId === sessionId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "session_messages_request",
            requestId,
            sessionId,
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
            ...(options.before !== undefined ? { before: options.before } : {}),
          }),
        ),
      "读取会话消息超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      messages: resp.messages,
      hasMore: resp.hasMore ?? false,
      ...(resp.nextBefore !== undefined ? { nextBefore: resp.nextBefore } : {}),
      ...(resp.before !== undefined ? { before: resp.before } : {}),
    }));
  }

  requestAgentStatuses(
    sessionId?: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<AgentStatusSnapshot> {
    const requestId = nextRequestId("agent-status");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "agent_status_response" }> =>
        msg.type === "agent_status_response" && msg.requestId === requestId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "agent_status_request",
            requestId,
            ...(sessionId ? { sessionId } : {}),
          }),
        ),
      "读取 Agent 状态超时",
      timeoutMs,
      requestId,
    ).then((resp) => resp.statuses);
  }

  requestSessionResources(
    sessionId: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<SessionResourcesSnapshot> {
    const requestId = nextRequestId("session-resources");
    return this.waitForMessage(
      (msg): msg is Extract<RelayControlMessage, { type: "session_resources_response" }> =>
        msg.type === "session_resources_response" &&
        msg.requestId === requestId &&
        msg.sessionId === sessionId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "session_resources_request",
            requestId,
            sessionId,
          }),
        ),
      "读取会话资源超时",
      timeoutMs,
      requestId,
    ).then((resp) => ({
      sessionId: resp.sessionId,
      commands: resp.commands,
      groups: resp.groups,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  createSession(
    request: Omit<SessionCreateRequest, "type" | "requestId">,
    timeoutMs = SESSION_CREATE_CLIENT_TIMEOUT_MS,
  ): Promise<SessionCreateResponse> {
    const requestId = nextRequestId("session-create");
    return this.waitForMessage(
      (msg): msg is SessionCreateResponse =>
        msg.type === "session_create_response" && msg.requestId === requestId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "session_create",
            requestId,
            ...request,
          }),
        ),
      "创建超时，请检查开发机连接后重试",
      timeoutMs,
    );
  }

  renameSession(
    sessionId: string,
    name: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<SessionRenameResult> {
    const requestId = nextRequestId("session-rename");
    return this.waitForMessage(
      (msg): msg is SessionRenameResponse =>
        msg.type === "session_rename_response" &&
        msg.requestId === requestId &&
        msg.sessionId === sessionId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "session_rename",
            requestId,
            sessionId,
            name,
          }),
        ),
      "重命名超时，请检查开发机连接后重试",
      timeoutMs,
    ).then((resp) => ({
      sessionId: resp.sessionId,
      success: resp.success,
      name: resp.name,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  // 发送 MessageEnvelope
  sendEnvelope(envelope: MessageEnvelope): boolean {
    return this.ws.send(JSON.stringify(envelope));
  }

  // 发送控制消息
  sendControl(msg: RelayControlMessage): boolean {
    return this.ws.send(JSON.stringify(msg));
  }

  private waitForMessage<T extends InboundMessage>(
    predicate: (msg: InboundMessage) => msg is T,
    send: () => boolean | void,
    timeoutMessage: string,
    timeoutMs: number,
    // 传入则同时监听 relay_error 上的同 requestId, 命中即按 relay 给的原因 reject。
    // 这条让 schema 不认 / proxy_offline 这类失败立刻报错而不是等 timeout 兜底。
    requestId?: string,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let unsubscribeMessage: (() => void) | null = null;
      let unsubscribeStatus: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (): void => {
        unsubscribeMessage?.();
        unsubscribeStatus?.();
        if (timer) clearTimeout(timer);
      };

      const settle = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };

      unsubscribeMessage = this.onMessage((msg) => {
        if (predicate(msg)) {
          settle(() => resolve(msg));
          return;
        }
        if (
          requestId &&
          msg.type === "relay_error" &&
          (msg as { requestId?: string }).requestId === requestId
        ) {
          const message = (msg as { message?: string }).message ?? "relay error";
          settle(() => reject(new Error(`Relay 服务器拒绝请求: ${message}`)));
        }
      });
      unsubscribeStatus = this.ws.onStatusChange((connected) => {
        if (connected) return;
        settle(() => reject(new Error("连接已断开")));
      });
      timer = setTimeout(() => {
        settle(() => reject(new Error(timeoutMessage)));
      }, timeoutMs);

      try {
        const sent = send();
        if (sent === false) {
          settle(() => reject(new Error("连接已断开")));
        }
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
  }

  getBoundProxyId(): string | null {
    return this.boundProxyId;
  }

  clearBoundProxy(proxyId?: string): void {
    if (!proxyId || this.boundProxyId === proxyId) {
      this.boundProxyId = null;
    }
  }

  // 注册收到消息的回调，返回取消注册函数
  onMessage(handler: (msg: InboundMessage) => void): () => void {
    this.messageHandlers.add(handler);
    if (this.pendingMessages.length > 0) {
      const buffered = this.pendingMessages;
      this.pendingMessages = [];
      for (const msg of buffered) {
        this.dispatch(msg);
      }
    }
    return () => {
      this.messageHandlers.delete(handler);
    };
  }
}
