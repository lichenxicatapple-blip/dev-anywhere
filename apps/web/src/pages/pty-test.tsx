import { useState, useEffect, useRef, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";
import { xtermTheme } from "@/lib/xterm-theme";
import { applySnapshot, findReplayStart, replayChunks, type ReplayChunk } from "@/lib/terminal-replay";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";

async function loadFixture(terminal: Terminal, name: string): Promise<void> {
  const resp = await fetch(`/fixtures/${name}.json`);
  if (!resp.ok) {
    console.error(`[pty-test] Failed to load fixture: ${resp.status}`);
    return;
  }
  const chunks: ReplayChunk[] = await resp.json();
  const startIndex = findReplayStart(chunks);
  replayChunks(terminal, chunks, startIndex);
  terminal.write("", () => terminal.scrollToBottom());
  console.log(`[pty-test] Fixture "${name}" loaded: replayed from index ${startIndex}/${chunks.length}`);
}

export function PtyTest() {
  const connected = useAppStore((s) => s.connected);
  const phase = useAppStore((s) => s.phase);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const relayUrl = useAppStore((s) => s.relayUrl);

  const [sessionId, setSessionId] = useState("");
  const [subscribed, setSubscribed] = useState(false);

  const terminalRef = useRef<Terminal | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const unsubBinaryRef = useRef<(() => void) | null>(null);

  // xterm.js 终端初始化
  useEffect(() => {
    let terminal: Terminal | null = null;
    let fitAddon: FitAddon | null = null;

    const init = async () => {
      // D-41: 等待 Sarasa Fixed SC 字体加载完成
      await document.fonts.ready;

      terminal = new Terminal({
        scrollback: 5000,
        fontFamily: '"Sarasa Fixed SC", "Noto Sans Mono CJK SC", ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
        fontSize: 14,
        cursorBlink: true,
        disableStdin: true,
        theme: xtermTheme,
        allowProposedApi: true,
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
        containerRef.current.replaceChildren();
        terminal.open(containerRef.current);
        fitAddon.fit();
      }

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      (window as unknown as Record<string, unknown>).__xterm = terminal;

      const params = new URLSearchParams(window.location.search || window.location.hash.split("?")[1] || "");
      const fixture = params.get("fixture");
      if (fixture) {
        fitAddon.dispose();
        fitAddonRef.current = null;
        loadFixture(terminal, fixture).then(() => {
          const xtermEl = containerRef.current?.querySelector(".xterm");
          if (xtermEl && containerRef.current) {
            containerRef.current.style.width = `${xtermEl.scrollWidth}px`;
          }
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

  // 清理 binary subscription
  useEffect(() => {
    return () => {
      unsubBinaryRef.current?.();
    };
  }, []);

  const handleSubscribe = useCallback(() => {
    if (subscribed) {
      unsubBinaryRef.current?.();
      unsubBinaryRef.current = null;
      setSubscribed(false);
      return;
    }

    if (!sessionId.trim() || !wsManagerRef || !relayClientRef) {
      return;
    }

    // 先 subscribeBinary，snapshot 到达前的 binary 帧丢弃
    let snapshotApplied = false;
    const unsub = wsManagerRef.subscribeBinary(sessionId, (data) => {
      if (snapshotApplied) {
        terminalRef.current?.write(data);
      }
    });
    unsubBinaryRef.current = unsub;

    // 监听 session_snapshot JSON 响应
    const unsubSnapshot = relayClientRef.onMessage((msg) => {
      const m = msg as Record<string, unknown>;
      if (m.type === "session_snapshot" && m.sessionId === sessionId) {
        unsubSnapshot();
        if (terminalRef.current && typeof m.data === "string") {
          terminalRef.current.reset();
          applySnapshot(terminalRef.current, {
            cols: m.cols as number,
            rows: m.rows as number,
            data: m.data as string,
          });
        }
        snapshotApplied = true;
      }
    });

    // 发送订阅请求，触发 terminal serialize()
    wsManagerRef.send(JSON.stringify({
      type: "session_subscribe",
      sessionId,
    }));

    setSubscribed(true);
  }, [subscribed, sessionId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubscribe();
  }, [handleSubscribe]);

  const statusDotClass = connected
    ? "bg-[var(--color-status-success)]"
    : "bg-[var(--muted-foreground)]";

  const statusText = [
    connected ? "WS Connected" : "WS Disconnected",
    `Phase: ${phase}`,
    proxyOnline ? "Proxy Online" : "Proxy Offline",
    subscribed ? `Subscribed: ${sessionId}` : "Not subscribed",
  ].join(" | ");

  return (
    <div className="flex flex-col h-screen bg-[var(--background)]">
      {/* StatusBar */}
      <div className="sticky top-0 z-10 flex items-center gap-2 px-4 h-12 bg-[var(--card)] border-b border-[var(--border)]">
        <div className={`w-2 h-2 rounded-full ${statusDotClass}`} />
        <span
          className="text-sm text-[var(--foreground)] truncate"
          style={{ fontFamily: "var(--font-sans)" }}
        >
          {statusText}
        </span>

        <div className="flex-1" />

        <span
          className="text-xs text-[var(--muted-foreground)] hidden sm:inline"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          {relayUrl}
        </span>

        <input
          type="text"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          onKeyDown={handleKeyDown}
          readOnly={subscribed}
          placeholder="session-id"
          className="w-[200px] h-8 px-2 rounded text-[13px] bg-[var(--input)] text-[var(--foreground)] border border-[var(--border)] focus:border-[var(--ring)] focus:outline-none"
          style={{
            fontFamily: "var(--font-mono)",
            opacity: subscribed ? 0.7 : 1,
          }}
        />

        <Button
          onClick={handleSubscribe}
          disabled={!connected || !sessionId.trim()}
          size="sm"
        >
          {subscribed ? "Unsubscribe" : "Subscribe"}
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
