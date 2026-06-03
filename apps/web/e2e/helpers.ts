import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

// 本地 Vite 默认端口 5173；CI 或外部 relay-served 部署可通过 WEB_BASE_URL 覆盖
export const BASE_URL = process.env.WEB_BASE_URL ?? "http://localhost:5173";

// 清理 DEV Anywhere 写入的 localStorage key 并刷新页面，恢复到首次访问状态.
// emu Chrome over CDP 上 evaluate 期间偶发 "Execution context was destroyed",
// 等 page idle 再 evaluate, evaluate 失败时容忍重试.
export async function resetLocalState(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.evaluate(() => {
        const keys = Object.keys(localStorage).filter((k) => k.startsWith("dev_anywhere_"));
        keys.forEach((k) => localStorage.removeItem(k));
      });
      break;
    } catch (err) {
      if (attempt === 1) throw err;
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20_000 });
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    }
  }
}

export type FakeRelayMessage = Record<string, unknown>;
export type FakeVoiceSocketPayload = string | ArrayBufferLike | Blob | ArrayBufferView;

declare global {
  interface Window {
    __devAnywhereE2E?: {
      sent: string[];
      socket: {
        emitJson(payload: FakeRelayMessage): void;
        emitPty(sessionId: string, data: string): void;
        close(): void;
      } | null;
      events: string[];
      holdConnections(): void;
      releaseConnections(): void;
      setImagePreviewDelay(ms: number): void;
      setImagePreviewDataBase64(value: string): void;
      setProxyOnline(online: boolean): void;
      voice: {
        asrSent: FakeVoiceSocketPayload[];
        ttsSent: string[];
        activeAsrSocketCount(): number;
        emitAsrFinal(text: string): number;
        emitTtsFinished(): void;
      };
    };
    __devAnywhereFakeRelayInstalled?: boolean;
  }
}

// 安装一个协议级 Fake Relay。它不是 mock 组件树，而是在浏览器 WebSocket 层模拟
// relay/proxy 的真实控制消息，让测试像用户一样点 UI，同时避免依赖本机真实 CLI。
export async function installFakeRelay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (window.__devAnywhereFakeRelayInstalled) return;
    Object.defineProperty(window, "__devAnywhereFakeRelayInstalled", {
      configurable: true,
      value: true,
    });

    const now = Date.now();
    let createCount = 0;
    const sessionStorageKey = "__dev_anywhere_e2e_sessions";
    const directoryStorageKey = "__dev_anywhere_e2e_dirs";
    const initializedKey = "__dev_anywhere_e2e_initialized";
    let imagePreviewDataBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
    const initialized = sessionStorage.getItem(initializedKey) === "1";
    if (!initialized) {
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem(initializedKey, "1");
    }

    type FakeSession = {
      sessionId: string;
      kind?: "agent" | "terminal";
      name?: string;
      state: "idle" | "working" | "waiting_approval" | "error" | "terminated";
      mode: "pty" | "json";
      provider: "claude" | "codex";
      ptyOwner?: "local-terminal" | "proxy-hosted";
      lastActive: number;
      cwd?: string;
      nameLocked?: boolean;
    };

    const defaultSessions: FakeSession[] = [
      {
        sessionId: "claude-pty",
        name: "/home/dev/projects/sample-app/",
        cwd: "/home/dev/projects/sample-app/",
        state: "idle",
        mode: "pty",
        provider: "claude",
        lastActive: now - 60_000,
      },
      {
        sessionId: "codex-pty",
        name: "/home/dev/projects/dev-anywhere/",
        cwd: "/home/dev/projects/dev-anywhere/",
        state: "working",
        mode: "pty",
        provider: "codex",
        lastActive: now - 120_000,
      },
      ...[
        "json-sess",
        "test-sess",
        "hist-sess",
        "f-sess",
        "fo-sess",
        "d51-sess",
        "voice-input-sess",
        "voice-mic-sess",
        "voice-second-turn-sess",
      ].map((sessionId, index) => ({
        sessionId,
        name: sessionId,
        cwd: `/home/dev/projects/${sessionId}`,
        state: "idle" as const,
        mode: "json" as const,
        provider: "claude" as const,
        lastActive: now - (index + 3) * 60_000,
      })),
    ];
    const relayClients = [
      {
        clientId: "browser-current",
        connectedAt: now - 30_000,
        current: true,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15",
        remoteAddress: "127.0.0.1",
      },
      {
        clientId: "browser-ipad",
        proxyId: "proxy-1",
        connectedAt: now - 120_000,
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15",
        remoteAddress: "192.168.1.23",
      },
    ];
    const persistedSessions = localStorage.getItem(sessionStorageKey);
    const sessions: FakeSession[] = persistedSessions
      ? (JSON.parse(persistedSessions) as FakeSession[])
      : defaultSessions;
    for (const session of defaultSessions) {
      if (!sessions.some((existing) => existing.sessionId === session.sessionId)) {
        sessions.push(session);
      }
    }
    const defaultDirectories = [
      "/home/dev",
      "/home/dev/projects/sample-app",
      "/home/dev/projects",
      "/home/dev/projects/dev-anywhere",
    ];
    const persistedDirectories = localStorage.getItem(directoryStorageKey);
    const directories = new Set<string>(
      persistedDirectories ? (JSON.parse(persistedDirectories) as string[]) : defaultDirectories,
    );
    const heldSockets = new Set<FakeRelayWebSocket>();
    const events: string[] = [];
    let holdConnections = false;
    let proxyOnlineState = true;
    let imagePreviewDelayMs = 0;
    const ptyBuffers = new Map<string, string>();
    const voiceAsrSent: FakeVoiceSocketPayload[] = [];
    const voiceTtsSent: string[] = [];
    type FakeVoiceSocketRef = {
      readyState: number;
      emitJson(payload: FakeRelayMessage): void;
    };
    const voiceAsrSockets = new Set<FakeVoiceSocketRef>();
    const voiceAsrActiveSockets = new Set<FakeVoiceSocketRef>();
    let voiceAsrSocket: FakeVoiceSocketRef | null = null;
    let voiceTtsSocket: { emitJson(payload: FakeRelayMessage): void } | null = null;

    function setVoiceAsrSocket(socket: FakeVoiceSocketRef): void {
      voiceAsrSocket = socket;
      voiceAsrSockets.add(socket);
    }

    function setVoiceTtsSocket(socket: { emitJson(payload: FakeRelayMessage): void }): void {
      voiceTtsSocket = socket;
    }

    function persistSessions(): void {
      localStorage.setItem(sessionStorageKey, JSON.stringify(sessions));
    }

    function persistDirectories(): void {
      localStorage.setItem(directoryStorageKey, JSON.stringify([...directories]));
    }

    const history = [
      {
        id: "hist-claude-1",
        title: "Claude history",
        projectDir: "/home/dev/projects/sample-app",
        updatedAt: now - 300_000,
        provider: "claude",
      },
      {
        id: "hist-codex-1",
        title: "Codex history",
        projectDir: "/home/dev/projects/dev-anywhere",
        updatedAt: now - 600_000,
        provider: "codex",
      },
    ];

    function envelope(type: string, sessionId: string, payload: unknown) {
      return {
        seq: Date.now(),
        sessionId,
        timestamp: Date.now(),
        source: "proxy",
        version: "1",
        type,
        payload,
      };
    }

    type FakeHistoryMessage = {
      role: "user" | "assistant" | "system";
      text: string;
      timestamp: number;
      cursor: string;
    };

    function makeHistoryMessage(index: number, label: string): FakeHistoryMessage {
      const role = index % 2 === 0 ? "assistant" : "user";
      return {
        role,
        text:
          index === 27
            ? "移动端历史问题：请检查 JSON 渲染。"
            : index === 28
              ? "移动端历史回复：历史消息已经加载。"
              : `${label} ${String(index).padStart(2, "0")}\n这是一条用于移动端上滑分页冒烟的 JSON 历史消息，内容较长以形成真实滚动高度。`,
        timestamp: now - (30 - index) * 1_000,
        cursor: `hist-${String(index).padStart(2, "0")}`,
      };
    }

    function emitHistoryPage(socket: FakeRelayWebSocket, msg: FakeRelayMessage): void {
      const sessionId = String(msg.sessionId);
      const before = typeof msg.before === "string" ? msg.before : undefined;
      if (sessionId !== "hist-sess") {
        socket.emitJson({
          type: "session_history_messages",
          requestId: msg.requestId,
          sessionId,
          messages: [],
          hasMore: false,
        });
        return;
      }

      if (before === "hist-before-13") {
        socket.emitJson({
          type: "session_history_messages",
          requestId: msg.requestId,
          sessionId,
          before,
          messages: Array.from({ length: 12 }, (_, i) => makeHistoryMessage(i + 1, "更早历史")),
          hasMore: false,
        });
        return;
      }

      socket.emitJson({
        type: "session_history_messages",
        requestId: msg.requestId,
        sessionId,
        messages: Array.from({ length: 16 }, (_, i) => makeHistoryMessage(i + 13, "最近历史")),
        hasMore: true,
        nextBefore: "hist-before-13",
      });
    }

    const outputSeqBySession = new Map<string, number>();

    function nextOutputSeq(sessionId: string): number {
      const next = (outputSeqBySession.get(sessionId) ?? 0) + 1;
      outputSeqBySession.set(sessionId, next);
      return next;
    }

    function currentOutputSeq(sessionId: string): number {
      return outputSeqBySession.get(sessionId) ?? 0;
    }

    function encodePtyFrame(sessionId: string, data: string): ArrayBuffer {
      const sid = new TextEncoder().encode(sessionId);
      const payload = new TextEncoder().encode(data);
      const frame = new Uint8Array(1 + sid.length + 4 + payload.length);
      frame[0] = sid.length;
      frame.set(sid, 1);
      new DataView(frame.buffer).setUint32(1 + sid.length, nextOutputSeq(sessionId), true);
      frame.set(payload, 1 + sid.length + 4);
      return frame.buffer;
    }

    class FakeRelayWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readonly url: string;
      readonly kind: "relay" | "voice-asr" | "voice-tts";
      binaryType: BinaryType = "arraybuffer";
      readyState = FakeRelayWebSocket.CONNECTING;

      constructor(url: string) {
        super();
        this.url = url;
        const path = new URL(url, window.location.href).pathname;
        this.kind = path.endsWith("/voice/asr")
          ? "voice-asr"
          : path.endsWith("/voice/tts")
            ? "voice-tts"
            : "relay";
        if (this.kind === "voice-asr") {
          setVoiceAsrSocket(this);
        } else if (this.kind === "voice-tts") {
          setVoiceTtsSocket(this);
        } else {
          window.__devAnywhereE2E!.socket = this;
        }
        setTimeout(() => {
          if (this.readyState !== FakeRelayWebSocket.CONNECTING) return;
          if (holdConnections) {
            heldSockets.add(this);
            return;
          }
          this.open();
        }, 0);
      }

      open(): void {
        if (this.readyState !== FakeRelayWebSocket.CONNECTING) return;
        heldSockets.delete(this);
        this.readyState = FakeRelayWebSocket.OPEN;
        events.push(`${this.kind}:open`);
        this.dispatchEvent(new Event("open"));
      }

      send(raw: FakeVoiceSocketPayload): void {
        if (this.kind === "voice-asr") {
          voiceAsrSent.push(raw);
          if (typeof raw === "string") {
            try {
              const voiceMsg = JSON.parse(raw) as FakeRelayMessage;
              events.push(`voice-asr:send:${String(voiceMsg.type ?? "unknown")}`);
              if (voiceMsg.type === "start") {
                voiceAsrActiveSockets.add(this);
              }
            } catch {
              // Non-control text on the voice ASR socket is still recorded above.
            }
          }
          return;
        }
        if (this.kind === "voice-tts") {
          if (typeof raw !== "string") return;
          voiceTtsSent.push(raw);
          try {
            const voiceMsg = JSON.parse(raw) as FakeRelayMessage;
            events.push(`voice-tts:send:${String(voiceMsg.type ?? "unknown")}`);
            if (voiceMsg.type === "speak") {
              this.emitJson({ type: "started", requestId: voiceMsg.requestId });
            }
          } catch {
            return;
          }
          return;
        }
        if (typeof raw !== "string") return;
        window.__devAnywhereE2E!.sent.push(raw);
        let msg: FakeRelayMessage;
        try {
          msg = JSON.parse(raw) as FakeRelayMessage;
        } catch {
          return;
        }
        events.push(`relay:send:${String(msg.type ?? "unknown")}`);

        switch (msg.type) {
          case "client_register":
            this.emitJson({ type: "client_register_response", status: "new" });
            break;
          case "proxy_list_request":
            this.emitProxyList(String(msg.requestId ?? ""));
            break;
          case "proxy_select":
            this.emitJson({
              type: "proxy_select_response",
              requestId: msg.requestId,
              success: true,
              proxyId: "proxy-1",
            });
            break;
          case "relay_client_list_request":
            this.emitJson({
              type: "relay_client_list_response",
              requestId: msg.requestId,
              clients: relayClients,
            });
            break;
          case "relay_client_kick": {
            const clientId = String(msg.clientId ?? "");
            if (relayClients.some((client) => client.clientId === clientId && client.current)) {
              this.emitJson({
                type: "relay_client_kick_response",
                requestId: msg.requestId,
                clientId,
                success: false,
                error: "不能断开当前客户端",
              });
              break;
            }
            const clientIndex = relayClients.findIndex((client) => client.clientId === clientId);
            const success = clientIndex !== -1;
            if (success) relayClients.splice(clientIndex, 1);
            this.emitJson({
              type: "relay_client_kick_response",
              requestId: msg.requestId,
              clientId,
              success,
              ...(success ? {} : { error: "客户端不在线" }),
            });
            break;
          }
          case "session_list":
            this.emitJson(envelope("session_list", "system", { sessions }));
            break;
          case "session_history_request":
            this.emitJson({
              type: "session_history_response",
              requestId: msg.requestId,
              sessions: history,
            });
            break;
          case "proxy_info_request":
            this.emitJson({
              type: "proxy_info",
              requestId: msg.requestId,
              homePath: "/home/dev",
              agentCli: {
                claude: {
                  available: true,
                  command: "/home/dev/.local/bin/claude",
                },
                codex: {
                  available: true,
                  command: "/home/dev/.local/bin/codex",
                },
              },
            });
            break;
          case "voice_config_request":
            this.emitJson({
              type: "voice_config_response",
              requestId: msg.requestId,
              config: {
                provider: "aliyun-bailian",
                configured: true,
                region: "cn",
                asrModel: "paraformer-realtime-v2",
                ttsModel: "cosyvoice-v3-flash",
                ttsVoice: "longxiaochun",
              },
            });
            break;
          case "voice_summary_request":
            this.emitJson({
              type: "voice_summary_response",
              requestId: msg.requestId,
              sessionId: String(msg.sessionId),
              messageId: String(msg.messageId),
              success: true,
              summary: "代码和表格内容已转换成语音摘要，重点是实现路径和风险。",
            });
            break;
          case "dir_list_request":
            this.emitJson({
              type: "dir_list_response",
              requestId: msg.requestId,
              path: String(msg.path),
              entries:
                msg.path === "/home/dev"
                  ? [
                      { name: "sample-app", isDir: true },
                      { name: "projects", isDir: true },
                      { name: "notes.md", isDir: false },
                    ]
                  : [
                      { name: "src", isDir: true },
                      { name: "README.md", isDir: false },
                    ],
            });
            break;
          case "dir_create_request": {
            const path = String(msg.path ?? "");
            directories.add(path);
            persistDirectories();
            this.emitJson({
              type: "dir_create_response",
              requestId: msg.requestId,
              path,
              success: true,
            });
            break;
          }
          case "clipboard_image_upload":
            this.emitJson({
              type: "clipboard_image_upload_response",
              requestId: msg.requestId,
              sessionId: String(msg.sessionId),
              success: true,
              path: `.dev-anywhere/clipboard/${String(msg.sessionId)}/pasted-e2e.png`,
            });
            break;
          case "file_download_request": {
            const sid = String(msg.sessionId);
            this.emitJson({
              type: "file_download_response",
              requestId: msg.requestId,
              sessionId: sid,
              success: true,
              path: String(msg.path),
              mimeType: "text/plain",
              dataBase64: "QUJD",
              size: 3,
            });
            break;
          }
          case "image_preview_request":
            setTimeout(() => {
              this.emitJson({
                type: "image_preview_response",
                requestId: msg.requestId,
                sessionId: String(msg.sessionId),
                success: true,
                path: String(msg.path),
                mimeType: "image/png",
                dataBase64: imagePreviewDataBase64,
                size: 68,
              });
            }, imagePreviewDelayMs);
            break;
          case "session_resources_request":
            this.emitResources(String(msg.sessionId ?? ""), String(msg.requestId ?? ""));
            break;
          case "agent_status_request":
            this.emitJson({
              type: "agent_status_response",
              requestId: msg.requestId,
              statuses: [
                {
                  sessionId: String(msg.sessionId ?? "json-sess"),
                  payload: {
                    provider: "claude",
                    phase: "idle",
                    seq: 1,
                    updatedAt: Date.now(),
                  },
                },
              ],
            });
            break;
          case "session_messages_request":
            emitHistoryPage(this, msg);
            break;
          case "session_subscribe":
            this.emitJson({
              type: "session_snapshot",
              sessionId: String(msg.sessionId),
              requestId: String(msg.requestId ?? ""),
              cols: 80,
              rows: 24,
              data: ptyBuffers.get(String(msg.sessionId)) ?? "Dev Anywhere PTY ready\r\n$ ",
              outputSeq: currentOutputSeq(String(msg.sessionId)),
            });
            this.emitJson({
              type: "terminal_title",
              sessionId: String(msg.sessionId),
              title: "Claude Code",
            });
            break;
          case "session_create": {
            if (msg.kind === "terminal") {
              const sessionId = `created-terminal-${++createCount}`;
              const cwd = "/home/dev/workspace";
              const name = "~/workspace";
              sessions.unshift({
                sessionId,
                kind: "terminal",
                name,
                cwd,
                state: "idle",
                mode: "pty",
                provider: "claude",
                ptyOwner: "local-terminal",
                lastActive: Date.now(),
              });
              persistSessions();
              this.emitJson({
                type: "session_create_response",
                requestId: msg.requestId,
                sessionId,
                kind: "terminal",
                name,
                mode: "pty",
                provider: "claude",
                ptyOwner: "local-terminal",
              });
              this.emitJson(envelope("session_list", "system", { sessions }));
              break;
            }
            const provider = msg.provider === "codex" ? "codex" : "claude";
            const mode = msg.mode === "json" ? "json" : "pty";
            const cwd = String(msg.cwd ?? "");
            const cwdKey = cwd.replace(/\/+$/, "") || "/";
            if (!directories.has(cwdKey)) {
              this.emitJson({
                type: "session_create_response",
                requestId: msg.requestId,
                errorCode: "PATH_NOT_FOUND",
                error: `工作目录不存在或不可访问: ${cwd}`,
              });
              break;
            }
            const sessionId = `created-${provider}-${mode}-${++createCount}`;
            sessions.unshift({
              sessionId,
              name: cwd,
              cwd,
              state: "idle",
              mode,
              provider,
              lastActive: Date.now(),
            });
            persistSessions();
            this.emitJson({
              type: "session_create_response",
              requestId: msg.requestId,
              sessionId,
              mode,
              provider,
            });
            this.emitJson(envelope("session_list", "system", { sessions }));
            break;
          }
          case "session_rename": {
            const sid = String(msg.sessionId ?? "");
            const nextName = String(msg.name ?? "").trim();
            const session = sessions.find((s) => s.sessionId === sid);
            if (!session || !nextName) {
              this.emitJson({
                type: "session_rename_response",
                requestId: msg.requestId,
                sessionId: sid,
                success: false,
                error: !session ? "Session not found" : "Session title cannot be empty",
                errorCode: !session ? "SESSION_NOT_FOUND" : "UNKNOWN",
              });
              break;
            }
            session.name = nextName;
            session.nameLocked = true;
            session.lastActive = Date.now();
            persistSessions();
            this.emitJson({
              type: "session_rename_response",
              requestId: msg.requestId,
              sessionId: sid,
              success: true,
              name: nextName,
            });
            this.emitJson(envelope("session_list", "system", { sessions }));
            break;
          }
          case "session_terminate":
            sessions.splice(
              0,
              sessions.length,
              ...sessions.filter((s) => s.sessionId !== msg.sessionId),
            );
            persistSessions();
            this.emitJson(envelope("session_list", "system", { sessions }));
            break;
          case "tool_approve":
          case "tool_deny":
            this.emitJson({
              type: "permission_decision_result",
              sessionId: String(msg.sessionId),
              requestId: String((msg.payload as { toolId?: string } | undefined)?.toolId),
              outcome: msg.type === "tool_approve" ? "allow" : "deny",
              delivered: true,
            });
            break;
          case "user_input":
            this.emitJson(
              envelope("user_input", String(msg.sessionId), {
                text: String((msg.payload as { text?: string } | undefined)?.text ?? ""),
                messageId:
                  (msg.payload as { messageId?: string } | undefined)?.messageId ??
                  `${String(msg.sessionId)}-user-${Date.now()}`,
              }),
            );
            this.emitJson(
              envelope("session_status", String(msg.sessionId), {
                sessionId: String(msg.sessionId),
                state: "working",
                lastActive: Date.now(),
              }),
            );
            this.emitJson(
              envelope("assistant_message", String(msg.sessionId), {
                text: "收到。",
                isPartial: false,
              }),
            );
            this.emitJson(
              envelope("session_status", String(msg.sessionId), {
                sessionId: String(msg.sessionId),
                state: "idle",
                lastActive: Date.now(),
              }),
            );
            break;
          default:
            break;
        }
      }

      close(): void {
        this.readyState = FakeRelayWebSocket.CLOSED;
        events.push(`${this.kind}:close`);
        if (this.kind === "voice-asr") {
          voiceAsrSockets.delete(this);
          voiceAsrActiveSockets.delete(this);
          if (voiceAsrSocket === this) voiceAsrSocket = null;
        }
        this.dispatchEvent(new Event("close"));
      }

      emitJson(payload: FakeRelayMessage): void {
        const statusEchoes: FakeRelayMessage[] = [];
        if (payload.type === "pty_state") {
          const session = sessions.find((s) => s.sessionId === payload.sessionId);
          const ptyPayload = payload.payload as { state?: string } | undefined;
          if (session && ptyPayload?.state === "approval_wait") {
            session.state = "waiting_approval";
            session.lastActive = Date.now();
          }
          if (session && ptyPayload?.state === "working") {
            session.state = "working";
            session.lastActive = Date.now();
          }
          if (session && ptyPayload?.state === "turn_complete") {
            session.state = "idle";
            session.lastActive = Date.now();
          }
          if (session) {
            statusEchoes.push(
              envelope("session_status", session.sessionId, {
                sessionId: session.sessionId,
                state: session.state,
                lastActive: session.lastActive,
              }),
            );
            persistSessions();
          }
        }
        if (payload.type === "session_status" && typeof payload.payload === "object") {
          const status = payload.payload as {
            sessionId?: string;
            state?: string;
            lastActive?: number;
          };
          const session = sessions.find((s) => s.sessionId === status.sessionId);
          if (session && typeof status.state === "string") {
            session.state = status.state as typeof session.state;
            session.lastActive = status.lastActive ?? Date.now();
            persistSessions();
          }
        }
        setTimeout(() => {
          for (const statusEcho of statusEchoes) {
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(statusEcho) }));
          }
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(payload) }));
        }, 0);
      }

      emitPty(sessionId: string, data: string): void {
        ptyBuffers.set(sessionId, `${ptyBuffers.get(sessionId) ?? ""}${data}`);
        this.dispatchEvent(new MessageEvent("message", { data: encodePtyFrame(sessionId, data) }));
      }

      private emitProxyList(requestId?: string): void {
        this.emitJson({
          type: "proxy_list_response",
          requestId,
          proxies: [
            {
              proxyId: "proxy-1",
              name: "Local Mac",
              online: proxyOnlineState,
              sessions: sessions.map((s) => s.sessionId),
            },
          ],
        });
      }

      private emitResources(sessionId: string, requestId?: string): void {
        this.emitJson({
          type: "session_resources_response",
          requestId,
          sessionId,
          commands: [
            {
              name: "/init",
              description: "Initialize project memory",
              argumentHint: "[optional context]",
              source: "claude",
            },
            { name: "/compact", description: "Compact context", source: "claude" },
          ],
          groups: [
            {
              path: "/home/dev/projects/sample-app",
              entries: [
                { name: "src", isDir: true },
                { name: "README.md", isDir: false },
              ],
            },
          ],
        });
        this.emitJson({
          type: "command_list_push",
          commands: [
            {
              name: "/init",
              description: "Initialize project memory",
              argumentHint: "[optional context]",
              source: "claude",
            },
            { name: "/compact", description: "Compact context", source: "claude" },
          ],
        });
        this.emitJson({
          type: "file_tree_push",
          groups: [
            {
              path: "/home/dev/projects/sample-app",
              entries: [
                { name: "src", isDir: true },
                { name: "README.md", isDir: false },
              ],
            },
          ],
        });
        if (sessionId === "json-sess") {
          this.emitJson({
            type: "pending_approvals_push",
            sessionId,
            approvals: [
              {
                requestId: "approval-1",
                toolName: "Bash",
                input: { command: "pnpm test" },
              },
            ],
          });
        }
      }
    }

    window.__devAnywhereE2E = {
      sent: [],
      socket: null,
      events,
      holdConnections() {
        holdConnections = true;
      },
      releaseConnections() {
        holdConnections = false;
        for (const socket of [...heldSockets]) {
          socket.open();
        }
      },
      setImagePreviewDelay(ms: number) {
        imagePreviewDelayMs = Math.max(0, ms);
      },
      setImagePreviewDataBase64(value: string) {
        imagePreviewDataBase64 = value;
      },
      setProxyOnline(online: boolean) {
        if (proxyOnlineState === online) return;
        proxyOnlineState = online;
        const socket = window.__devAnywhereE2E!.socket as FakeRelayWebSocket | null;
        if (!socket) return;
        socket.emitJson({
          type: online ? "proxy_online" : "proxy_offline",
          proxyId: "proxy-1",
        });
      },
      voice: {
        asrSent: voiceAsrSent,
        ttsSent: voiceTtsSent,
        activeAsrSocketCount() {
          return [...voiceAsrActiveSockets].filter(
            (socket) => socket.readyState === FakeRelayWebSocket.OPEN,
          ).length;
        },
        emitAsrFinal(text: string) {
          const activeSockets = [...voiceAsrActiveSockets].filter(
            (socket) => socket.readyState === FakeRelayWebSocket.OPEN,
          );
          const openSockets = [...voiceAsrSockets].filter(
            (socket) => socket.readyState === FakeRelayWebSocket.OPEN,
          );
          const targets =
            activeSockets.length > 0
              ? activeSockets
              : openSockets.length > 0
                ? openSockets
                : voiceAsrSocket
                  ? [voiceAsrSocket]
                  : [];
          events.push(`voice-asr:emit-final:${targets.length}:${text}`);
          for (const socket of targets) {
            socket.emitJson({ type: "final", text });
          }
          return targets.length;
        },
        emitTtsFinished() {
          voiceTtsSocket?.emitJson({ type: "finished" });
        },
      },
    };
    window.WebSocket = FakeRelayWebSocket as unknown as typeof WebSocket;
  });
}

export async function selectFakeProxy(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/#/`);
  if ((page.viewportSize()?.width ?? 0) >= 768) {
    await page.locator('[data-slot="proxy-switcher-trigger"]').click();
  }
  await page.locator('[data-slot="proxy-item"][data-proxy-id="proxy-1"]:visible').last().click();
  await expect(
    page
      .locator(
        '[data-slot="create-session-trigger"]:visible, [data-slot="create-session-mobile-trigger"]:visible',
      )
      .first(),
  ).toBeVisible();
}

export async function openCreateAgentSessionDialog(page: Page) {
  if ((page.viewportSize()?.width ?? 0) < 768) {
    await page.locator('[data-slot="create-session-mobile-trigger"]:visible').click();
    await page.locator('[data-slot="create-agent-session-sheet-item"]').click();
  } else {
    await page.locator('[data-slot="create-session-trigger"]:visible').last().click();
    await page.locator('[data-slot="create-agent-session-item"]').click();
  }
  const dialog = page.locator('[data-slot="create-session-dialog"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

export async function gotoWithFakeProxy(page: Page, path: string): Promise<void> {
  await selectFakeProxy(page);
  await page.goto(`${BASE_URL}${path}`);
}

export async function sentFakeRelayMessages(page: Page): Promise<FakeRelayMessage[]> {
  return page.evaluate(() =>
    (window.__devAnywhereE2E?.sent ?? []).flatMap((raw) => {
      try {
        return [JSON.parse(raw) as Record<string, unknown>];
      } catch {
        return [];
      }
    }),
  );
}
