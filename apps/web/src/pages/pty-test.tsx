import { useState, useEffect, useRef, useCallback } from "react";
import type { Terminal } from "@xterm/xterm";
import { Button } from "@/components/ui/button";
import { createXtermTerminal } from "@/lib/create-xterm";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";

export function PtyTest() {
  const connected = useAppStore((s) => s.connected);
  const phase = useAppStore((s) => s.phase);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const relayUrl = useAppStore((s) => s.relayUrl);

  const [sessionId, setSessionId] = useState("");
  const [subscribed, setSubscribed] = useState(false);

  const terminalRef = useRef<Terminal | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const unsubBinaryRef = useRef<(() => void) | null>(null);

  // xterm.js 终端初始化
  useEffect(() => {
    let disposeFn: (() => void) | null = null;
    let cancelled = false;

    const init = async () => {
      const container = containerRef.current;
      if (!container) return;
      const result = await createXtermTerminal(container);
      if (cancelled) {
        result.dispose();
        return;
      }
      terminalRef.current = result.terminal;
      disposeFn = result.dispose;
      (window as unknown as Record<string, unknown>).__xterm = result.terminal;
    };

    init();

    document.title = "PTY Test -- CC Anywhere";

    return () => {
      cancelled = true;
      disposeFn?.();
      terminalRef.current = null;
      delete (window as unknown as Record<string, unknown>).__xterm;
    };
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
          terminalRef.current.resize(m.cols as number, m.rows as number);
          terminalRef.current.write(m.data as string, () => {
            // 容器宽度跟随 xterm 实际渲染宽度
            const xtermEl = containerRef.current?.querySelector(".xterm");
            if (xtermEl && containerRef.current) {
              containerRef.current.style.width = `${xtermEl.scrollWidth}px`;
            }
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

      <div className="flex-1 overflow-auto" style={{ backgroundColor: "#1E1E1E" }}>
        <div
          ref={containerRef}
          style={{ minHeight: "100%" }}
        />
      </div>
    </div>
  );
}
