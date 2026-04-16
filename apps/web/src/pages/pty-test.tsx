import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { xtermTheme } from "@/lib/xterm-theme";
import { findReplayStart, replayChunks, type ReplayChunk } from "@/lib/terminal-replay";

type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

const STATUS_DOT_CLASS: Record<ConnectionStatus, string> = {
  disconnected: "bg-[var(--muted-foreground)]",
  connecting: "bg-[var(--color-status-working)] animate-pulse",
  connected: "bg-[var(--color-status-success)]",
  error: "bg-[var(--color-status-error)]",
};

function getStatusText(status: ConnectionStatus, errorMsg: string): string {
  if (status === "error") return `Error: ${errorMsg}`;
  const labels: Record<Exclude<ConnectionStatus, "error">, string> = {
    disconnected: "Disconnected",
    connecting: "Connecting...",
    connected: "Connected",
  };
  return labels[status];
}

async function loadFixture(terminal: Terminal, name: string): Promise<void> {
  const resp = await fetch(`/fixtures/${name}.json`);
  if (!resp.ok) {
    console.error(`[pty-test] Failed to load fixture: ${resp.status}`);
    return;
  }
  const chunks: ReplayChunk[] = await resp.json();
  const startIndex = findReplayStart(chunks);
  replayChunks(terminal, chunks, startIndex);
  // 所有 write 是异步排队的，用空 write 回调确保前面的数据处理完后再滚动到底部
  terminal.write("", () => terminal.scrollToBottom());
  console.log(`[pty-test] Fixture "${name}" loaded: replayed from index ${startIndex}/${chunks.length}`);
}

export function PtyTest() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [errorMsg, setErrorMsg] = useState("");
  const [relayUrl, setRelayUrl] = useState("ws://localhost:5173/client");
  const [sessionId, setSessionId] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // 初始化 xterm.js 终端
  useEffect(() => {
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;

    const init = async () => {
      // D-41: 等待 Sarasa Fixed SC 字体加载完成
      await document.fonts.ready;

      terminal = new Terminal({
        scrollback: 5000, // D-19
        fontFamily: '"Sarasa Fixed SC", "Noto Sans Mono CJK SC", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
        fontSize: 14,
        cursorBlink: true,
        disableStdin: true, // D-44: 只读模式
        theme: xtermTheme, // D-40
        allowProposedApi: true, // @xterm/addon-serialize 需要
      });

      fitAddon = new FitAddon();
      const serializeAddon = new SerializeAddon();
      const webLinksAddon = new WebLinksAddon();
      const unicode11Addon = new Unicode11Addon();

      terminal.loadAddon(fitAddon);
      terminal.loadAddon(serializeAddon);
      terminal.loadAddon(webLinksAddon);
      terminal.loadAddon(unicode11Addon);
      terminal.unicode.activeVersion = "11";

      if (containerRef.current) {
        // StrictMode 双渲染时清除前一次残留的 DOM
        containerRef.current.replaceChildren();
        terminal.open(containerRef.current);
        fitAddon.fit();
      }

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // 暴露给 Playwright 测试注入数据
      (window as unknown as Record<string, unknown>).__xterm = terminal;

      // URL 参数 ?fixture=<name> 时加载 fixture 回放，禁用 FitAddon 锁定 PTY 原始尺寸
      const params = new URLSearchParams(window.location.search || window.location.hash.split("?")[1] || "");
      const fixture = params.get("fixture");
      if (fixture) {
        fitAddon.dispose();
        fitAddonRef.current = null;
        loadFixture(terminal, fixture).then(() => {
          // 容器宽度贴合 terminal 实际渲染宽度，避免右侧空白
          const xtermEl = containerRef.current?.querySelector(".xterm");
          if (xtermEl && containerRef.current) {
            containerRef.current.style.width = `${xtermEl.scrollWidth}px`;
          }
          // 外层滚动容器滚到底部，显示终端最新状态
          const scrollContainer = containerRef.current?.parentElement;
          if (scrollContainer) {
            scrollContainer.scrollTop = scrollContainer.scrollHeight;
          }
        });
      }
    };

    init();

    document.title = "PTY Test -- CC Anywhere";

    return () => {
      terminal?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      delete (window as unknown as Record<string, unknown>).__xterm;
    };
  }, []);

  // 容器尺寸变化时自动适配
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const ro = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // 连接/断开 WebSocket
  const handleConnect = useCallback(() => {
    if (status === "connected") {
      wsRef.current?.close();
      wsRef.current = null;
      setStatus("disconnected");
      return;
    }

    if (!relayUrl.trim() || !sessionId.trim()) {
      return;
    }

    setStatus("connecting");
    setErrorMsg("");

    // D-25: 原生 WebSocket
    const ws = new WebSocket(relayUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "client_register",
        clientId: `pty-test-${Date.now()}`,
      }));
    };

    ws.onmessage = (event: MessageEvent) => {
      // D-26: 按数据类型分发
      if (event.data instanceof ArrayBuffer) {
        // D-43: 解析 binary frame，按 sessionId 过滤
        const view = new Uint8Array(event.data);
        if (view.length < 2) return;
        const sidLen = view[0];
        if (view.length < 1 + sidLen) return;
        const frameSid = new TextDecoder().decode(view.subarray(1, 1 + sidLen));
        if (sessionId && frameSid !== sessionId) return;
        const ptyData = view.subarray(1 + sidLen);
        terminalRef.current?.write(ptyData);
      } else {
        try {
          const msg = JSON.parse(event.data as string);
          console.log("[pty-test] JSON message:", msg.type, msg);

          // 收到注册响应后，请求 proxy 列表
          if (msg.type === "client_register_response") {
            ws.send(JSON.stringify({
              type: "proxy_list_request",
            }));
          }
          // proxy_select 成功后标记为已连接
          if (msg.type === "proxy_select_response" && msg.success) {
            setStatus("connected");
          }
          // proxy 列表推送：自动选择第一个在线的 proxy
          if (msg.type === "proxy_list_response" && Array.isArray(msg.proxies)) {
            const onlineProxy = msg.proxies.find((p: { online: boolean }) => p.online);
            if (onlineProxy) {
              ws.send(JSON.stringify({
                type: "proxy_select",
                proxyId: onlineProxy.proxyId,
              }));
            }
          }
        } catch (err) {
          console.error("[pty-test] Failed to parse JSON message:", err, event.data);
        }
      }
    };

    ws.onerror = () => {
      setStatus("error");
      setErrorMsg("WebSocket connection failed");
    };

    ws.onclose = (event) => {
      if (wsRef.current === ws) {
        setStatus("error");
        setErrorMsg(`Connection closed: ${event.reason || "unknown"}`);
      }
    };
  }, [status, relayUrl, sessionId]);

  // 回车键触发连接
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleConnect();
  }, [handleConnect]);

  // 清理 WebSocket
  useEffect(() => {
    return () => {
      wsRef.current?.close();
    };
  }, []);

  const isConnected = status === "connected";

  return (
    <div className="flex flex-col h-screen bg-[var(--background)]">
      {/* StatusBar */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-[var(--card)] border-b border-[var(--border)]">
        <div className={`w-2 h-2 rounded-full ${STATUS_DOT_CLASS[status]}`} />
        <span
          className="text-sm text-[var(--foreground)]"
          style={{ fontFamily: "var(--font-sans)" }}
        >
          {getStatusText(status, errorMsg)}
        </span>

        <div className="flex-1" />

        <input
          type="text"
          value={relayUrl}
          onChange={(e) => setRelayUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          readOnly={isConnected}
          placeholder="ws://localhost:3100/client"
          className="w-[280px] h-8 px-2 rounded text-[13px] bg-[var(--input)] text-[var(--foreground)] border border-[var(--border)] focus:border-[var(--ring)] focus:outline-none"
          style={{
            fontFamily: "var(--font-mono)",
            opacity: isConnected ? 0.7 : 1,
          }}
        />

        <input
          type="text"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          onKeyDown={handleKeyDown}
          readOnly={isConnected}
          placeholder="session-id"
          className="w-[200px] h-8 px-2 rounded text-[13px] bg-[var(--input)] text-[var(--foreground)] border border-[var(--border)] focus:border-[var(--ring)] focus:outline-none"
          style={{
            fontFamily: "var(--font-mono)",
            opacity: isConnected ? 0.7 : 1,
          }}
        />

        <Button
          onClick={handleConnect}
          disabled={status === "connecting"}
          size="sm"
        >
          {isConnected ? "Disconnect" : "Connect"}
        </Button>
      </div>

      {/* 外层滚动容器撑满屏幕，内层贴合 terminal 实际宽度 */}
      <div className="flex-1 overflow-auto" style={{ backgroundColor: "#1E1E1E" }}>
        <div
          ref={containerRef}
          style={{ width: "fit-content", minHeight: "100%" }}
        />
      </div>
    </div>
  );
}
