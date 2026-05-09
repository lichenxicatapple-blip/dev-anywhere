// Relay 协议客户端，处理注册、代理选择、消息发送和控制消息路由
import type { WebSocketManager } from "@/services/websocket";
import type {
  AgentStatusPayload,
  AgentCliStatus,
  CommandEntry,
  DirEntry,
  FileTreeGroup,
  HistorySession,
  MessageEnvelope,
  RelayControlMessage,
} from "@dev-anywhere/shared";
import type { ControlErrorCodeType } from "@/lib/control-error-code";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

type InboundMessage = MessageEnvelope | RelayControlMessage;
type ProxyInfoResult = Array<{
  proxyId: string;
  name?: string;
  online: boolean;
  sessions?: string[];
}>;
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
type ClipboardImageUploadResponse = Extract<
  RelayControlMessage,
  { type: "clipboard_image_upload_response" }
>;
type ClipboardImageUploadResult = {
  sessionId: string;
  success: boolean;
  path: string;
} & RequestError;
type ClipboardImageUploadRequest = Omit<
  Extract<RelayControlMessage, { type: "clipboard_image_upload" }>,
  "type" | "requestId" | "sessionId"
>;
type ImagePreviewResponse = Extract<RelayControlMessage, { type: "image_preview_response" }>;
type ImagePreviewResult = {
  sessionId: string;
  success: boolean;
  path: string;
  mimeType?: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  dataBase64?: string;
  size?: number;
} & RequestError;
type RelayTransport = Pick<WebSocketManager, "onMessage" | "onStatusChange" | "send">;
type SessionCreateRequest = Extract<RelayControlMessage, { type: "session_create" }>;
type SessionCreateResponse = Extract<RelayControlMessage, { type: "session_create_response" }>;
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

  // 发送 client_register，携带 clientId 和各 session 已收到的最大 seq
  // 注册意味着新连接，旧绑定对新 relay 实例无效
  register(): void {
    this.boundProxyId = null;
    this.ws.send(
      JSON.stringify({
        type: "client_register",
        clientId: this.clientId,
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
    ).then((msg) => msg.proxies as ProxyInfoResult);
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
    ).then((resp) => ({
      path: resp.path,
      entries: resp.entries,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  uploadClipboardImage(
    sessionId: string,
    image: ClipboardImageUploadRequest,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<ClipboardImageUploadResult> {
    const requestId = nextRequestId("clipboard-image");
    return this.waitForMessage(
      (msg): msg is ClipboardImageUploadResponse =>
        msg.type === "clipboard_image_upload_response" &&
        msg.requestId === requestId &&
        msg.sessionId === sessionId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "clipboard_image_upload",
            requestId,
            sessionId,
            ...image,
          }),
        ),
      "上传剪贴板图片超时",
      timeoutMs,
    ).then((resp) => ({
      sessionId: resp.sessionId,
      success: resp.success,
      path: resp.path,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
  }

  requestImagePreview(
    sessionId: string,
    path: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<ImagePreviewResult> {
    const requestId = nextRequestId("image-preview");
    return this.waitForMessage(
      (msg): msg is ImagePreviewResponse =>
        msg.type === "image_preview_response" &&
        msg.requestId === requestId &&
        msg.sessionId === sessionId,
      () =>
        this.ws.send(
          JSON.stringify({
            type: "image_preview_request",
            requestId,
            sessionId,
            path,
          }),
        ),
      "读取图片超时",
      timeoutMs,
    ).then((resp) => ({
      sessionId: resp.sessionId,
      success: resp.success,
      path: resp.path,
      mimeType: resp.mimeType,
      dataBase64: resp.dataBase64,
      size: resp.size,
      error: resp.error,
      errorCode: resp.errorCode,
    }));
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
    ).then((resp) => ({
      provider: resp.provider,
      agentCli: resp.agentCli,
      error: resp.error,
      errorCode: resp.errorCode,
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
    timeoutMs = 15_000,
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
        if (!predicate(msg)) return;
        settle(() => resolve(msg));
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
