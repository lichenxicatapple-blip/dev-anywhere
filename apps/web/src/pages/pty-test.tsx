import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { xtermTheme } from "@/lib/xterm-theme";

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
        fontFamily: '"Sarasa Fixed SC", ui-monospace, SFMono-Regular, Menlo, monospace',
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
        terminal.open(containerRef.current);
        fitAddon.fit();
      }

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;
    };

    init();

    document.title = "PTY Test -- CC Anywhere";

    return () => {
      terminal?.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
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
      setStatus("connected");
    };

    ws.onmessage = (event: MessageEvent) => {
      // D-26: 按数据类型分发
      if (event.data instanceof ArrayBuffer) {
        // D-43: 解析 binary frame
        const view = new Uint8Array(event.data);
        if (view.length < 2) return;
        const sessionIdLen = view[0];
        const ptyData = view.subarray(1 + sessionIdLen);
        terminalRef.current?.write(ptyData);
      } else {
        try {
          const msg = JSON.parse(event.data as string);
          console.log("[pty-test] JSON message:", msg.type);
        } catch {
          // 忽略解析错误
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

      {/* xterm.js 终端容器 */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden"
        style={{ backgroundColor: "#1E1E1E" }}
      />
    </div>
  );
}
