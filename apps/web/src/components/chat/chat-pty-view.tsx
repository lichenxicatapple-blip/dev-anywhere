// PTY 模式 Chat 视图：自包含 xterm + 内联 status 条 + 浮层 ToolApproval 占位
// 输入条和语义功能面板由 Plan 10-04b 在 chat.tsx 作为 sibling 组合，不在此处引入
// xterm 配置通过 createXtermTerminal 与 /pty-test 保持一致（Phase 9 锁定）
//
// 说明：正式版 StatusLine 与 ToolApprovalCard 由 Plan 10-04 创建，
// 本文件在 Wave 4 暂用内联 minimal 实现以避免跨 Plan 构造顺序耦合；
// Plan 10-04b 接入 chat.tsx 时可选择替换为正式组件。
import { useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { SerializeAddon } from "@xterm/addon-serialize";
import { createXtermTerminal } from "@/lib/create-xterm";
import { wsManagerRef, relayClientRef } from "@/hooks/use-relay-setup";
import { useAppStore } from "@/stores/app-store";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";

interface ChatPtyViewProps {
  sessionId: string;
}

export function ChatPtyView({ sessionId }: ChatPtyViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const [ready, setReady] = useState(false);
  // "PTY 正在连接..." overlay 延迟 300ms 才展示：HMR remount 或快速重连通常 50~100ms 就拿到 snapshot，
  // 不延迟会让每次热更新都闪一下遮罩
  const [showConnectingOverlay, setShowConnectingOverlay] = useState(false);
  // subscribe 后持续 timeout 未收到 snapshot 即进入穷尽态：露出错误 + 手动重试按钮
  const [subscribeExhausted, setSubscribeExhausted] = useState(false);
  // 手动重试触发器：点重试按钮 +1 让订阅 effect 重跑
  const [retryNonce, setRetryNonce] = useState(0);
  useEffect(() => {
    if (ready) {
      setShowConnectingOverlay(false);
      return;
    }
    const t = setTimeout(() => setShowConnectingOverlay(true), 300);
    return () => clearTimeout(t);
  }, [ready]);
  // 订阅 / 创建 xterm 必须等 WS 连接 + proxy 已绑定：
  // useEffect 按 deepest-first 跑，子组件 effect 早于 App 的 useRelaySetup，
  // 依赖 connected/proxyOnline 变 true 后重跑，否则 refs 为 null 会 early return 再也不重订阅
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const ptyAutoscale = useAppStore((s) => s.ptyAutoscale);
  const pendingApprovals = useChatStore(
    (s) => s.bySessionId[sessionId]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals,
  );
  const pending = pendingApprovals.find((a) => a.status === "pending");

  useEffect(() => {
    if (!connected || !proxyOnline) return;
    const container = containerRef.current;
    if (!container) return;
    let disposeFn: (() => void) | null = null;
    let unsubBinary: (() => void) | null = null;
    let unsubSnapshot: (() => void) | null = null;
    let cleanupRetry: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const result = await createXtermTerminal(container);
      if (cancelled) {
        result.dispose();
        return;
      }
      terminalRef.current = result.terminal;
      serializeRef.current = result.serializeAddon;
      disposeFn = result.dispose;

      // snapshot 到达前的 binary 帧先入 buffer，snapshot 还原后一次性 flush
      let snapshotApplied = false;
      const frameBuffer: Uint8Array[] = [];

      const ws = wsManagerRef;
      const relay = relayClientRef;
      if (!ws || !relay) return;

      unsubBinary = ws.subscribeBinary(sessionId, (data) => {
        if (!snapshotApplied) {
          frameBuffer.push(data);
          return;
        }
        terminalRef.current?.write(data);
      });

      // 订阅 snapshot 超时自愈：subscribe 发出后 3s 内没回 snapshot 就重发，最多重试 3 次
      const RETRY_DELAY_MS = 3000;
      const MAX_RETRIES = 3;
      let retryTimer: ReturnType<typeof setTimeout> | null = null;
      let retryCount = 0;

      const clearRetry = (): void => {
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
      };

      const attemptSubscribe = (): void => {
        if (cancelled || snapshotApplied) return;
        ws.send(JSON.stringify({ type: "session_subscribe", sessionId }));
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (cancelled || snapshotApplied) return;
          if (retryCount >= MAX_RETRIES) {
            setSubscribeExhausted(true);
            return;
          }
          retryCount += 1;
          attemptSubscribe();
        }, RETRY_DELAY_MS);
      };

      unsubSnapshot = relay.onMessage((msg) => {
        const m = msg as Record<string, unknown>;
        if (m.type !== "session_snapshot" || m.sessionId !== sessionId) return;
        const term = terminalRef.current;
        if (!term) return;
        clearRetry();
        term.reset();
        term.resize(m.cols as number, m.rows as number);
        term.write(m.data as string, () => {
          for (const frame of frameBuffer) {
            term.write(frame);
          }
          frameBuffer.length = 0;
        });
        snapshotApplied = true;
        setReady(true);
        setSubscribeExhausted(false);
      });

      attemptSubscribe();

      cleanupRetry = clearRetry;
    })();

    return () => {
      cancelled = true;
      cleanupRetry?.();
      unsubBinary?.();
      unsubSnapshot?.();
      disposeFn?.();
      terminalRef.current = null;
      serializeRef.current = null;
    };
  }, [sessionId, connected, proxyOnline, retryNonce]);

  // autoscale off 时 xterm 高度 > 容器会出现垂直溢出, 外层 overflow-auto 承担滚动.
  // 用 ResizeObserver pin 到底: scrollHeight 任何一次变化都重新滚到最底,
  // 保证首屏看到 Claude Code 的输入行 + 状态栏 (xterm WebGL atlas 初始化可能晚于 snapshot)
  useEffect(() => {
    if (!ready) return;
    const el = containerRef.current;
    if (!el) return;
    const pinBottom = (): void => {
      el.scrollTop = el.scrollHeight;
    };
    pinBottom();
    const ro = new ResizeObserver(pinBottom);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [ready, ptyAutoscale]);

  // autoscale fontSize: 按容器尺寸反推字号, 让 xterm 的 cell 铺满视口.
  // cols/rows 保持 snapshot 给的原值, CUP 坐标系与 proxy 1:1 不动.
  // 关闭时复位字号 14, 由外层 overflow-auto 承担滚动
  useEffect(() => {
    if (!ready) return;
    const container = containerRef.current;
    const term = terminalRef.current;
    if (!container || !term) return;

    if (!ptyAutoscale) {
      if (term.options.fontSize !== 14) {
        term.options.fontSize = 14;
      }
      return;
    }

    const fit = (): void => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      const { cols, rows } = term;
      if (!w || !h || !cols || !rows) return;
      // monospace 经验常数: cell_w ≈ fontSize * 0.6, cell_h ≈ fontSize * 1.2
      const byWidth = w / cols / 0.6;
      const byHeight = h / rows / 1.2;
      const next = Math.max(8, Math.min(16, Math.floor(Math.min(byWidth, byHeight))));
      if (term.options.fontSize !== next) {
        term.options.fontSize = next;
      }
    };

    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(container);
    return () => ro.disconnect();
  }, [ready, ptyAutoscale]);

  return (
    <div className="flex flex-col h-full relative" data-slot="chat-pty-view">
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto bg-[#1E1E1E] pt-2 will-change-scroll"
        data-slot="pty-terminal"
      />
      {showConnectingOverlay && !subscribeExhausted && (
        <div
          className="absolute top-0 left-0 right-0 h-8 flex items-center justify-center bg-card/60 text-xs text-muted-foreground"
          data-slot="pty-connecting"
        >
          PTY 正在连接...
        </div>
      )}
      {subscribeExhausted && (
        <div
          className="absolute top-0 left-0 right-0 h-10 flex items-center justify-center gap-3 bg-destructive/10 text-xs text-destructive"
          data-slot="pty-subscribe-failed"
          role="alert"
        >
          <span>PTY 订阅未响应，请重试</span>
          <button
            type="button"
            onClick={() => {
              setReady(false);
              setSubscribeExhausted(false);
              setRetryNonce((n) => n + 1);
            }}
            className="rounded-sm border border-destructive/40 px-2 py-0.5 text-destructive hover:bg-destructive/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
          >
            重试
          </button>
        </div>
      )}
      {pending && (
        <div
          className="absolute bottom-4 right-4 z-20 w-80 rounded-md border border-border bg-card shadow-lg p-3 text-sm"
          data-slot="pty-tool-approval-floating"
          role="dialog"
          aria-label={`工具审批：${pending.toolName}`}
        >
          <div className="font-medium text-foreground">
            {pending.toolName}
          </div>
          <div className="mt-1 text-xs text-muted-foreground truncate">
            {JSON.stringify(pending.input).slice(0, 120)}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            正式审批按钮由 Plan 10-04 的 ToolApprovalCard 提供
          </div>
        </div>
      )}
    </div>
  );
}
