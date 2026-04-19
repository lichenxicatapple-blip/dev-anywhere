// PTY 模式 Chat 视图: 自包含 xterm + 内联 status 条 + 浮层 ToolApproval 占位
// 滚动交由浏览器原生: 外层 .pty-terminal (overflow-auto) 做 scrollable, spacer 撑出 buffer.length*cellH,
// xterm 挂在 position:sticky 的 host. scroll 事件 -> term.scrollToLine(ydisp), term.onScroll -> 同步 scrollTop.
// canvas 比容器高时 (autoscale off 手机竖屏常见), sticky release 阶段自然暴露 canvas 底部, 代替老 pinBottom.
// 好处: touch/wheel/fling/momentum/edge bounce 全部走浏览器合成线程, 无 JS jank, 和原生 app 手感一致.
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
  const spacerRef = useRef<HTMLDivElement>(null);
  const xtermHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const [ready, setReady] = useState(false);
  const [showConnectingOverlay, setShowConnectingOverlay] = useState(false);
  const [subscribeExhausted, setSubscribeExhausted] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  useEffect(() => {
    if (ready) {
      setShowConnectingOverlay(false);
      return;
    }
    const t = setTimeout(() => setShowConnectingOverlay(true), 300);
    return () => clearTimeout(t);
  }, [ready]);
  const connected = useAppStore((s) => s.connected);
  const proxyOnline = useAppStore((s) => s.proxyOnline);
  const ptyAutoscale = useAppStore((s) => s.ptyAutoscale);
  const pendingApprovals = useChatStore(
    (s) => s.bySessionId[sessionId]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals,
  );
  const pending = pendingApprovals.find((a) => a.status === "pending");

  useEffect(() => {
    if (!connected || !proxyOnline) return;
    const host = xtermHostRef.current;
    if (!host) return;
    let disposeFn: (() => void) | null = null;
    let unsubBinary: (() => void) | null = null;
    let unsubSnapshot: (() => void) | null = null;
    let cleanupRetry: (() => void) | null = null;
    let cancelled = false;

    (async () => {
      const result = await createXtermTerminal(host);
      if (cancelled) {
        result.dispose();
        return;
      }
      terminalRef.current = result.terminal;
      serializeRef.current = result.serializeAddon;
      disposeFn = result.dispose;

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
        if (m.sessionId !== sessionId) return;
        if (m.type === "terminal_resize") {
          terminalRef.current?.resize(m.cols as number, m.rows as number);
          snapshotApplied = false;
          ws.send(JSON.stringify({ type: "session_subscribe", sessionId }));
          return;
        }
        if (m.type !== "session_snapshot") return;
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

  // 同步 spacer 尺寸 + scroll 双向绑定 + 初始 pin-bottom.
  // 用一个 effect 统一管理生命周期, 避免多个 effect 各自持有 syncing 标志时互相打架.
  useEffect(() => {
    if (!ready) return;
    const container = containerRef.current;
    const spacer = spacerRef.current;
    const host = xtermHostRef.current;
    const term = terminalRef.current;
    if (!container || !spacer || !host || !term) return;

    const getDims = (): { cellH: number; cellW: number } => {
      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      if (!screen || term.rows === 0 || term.cols === 0) return { cellH: 0, cellW: 0 };
      return {
        cellH: screen.clientHeight / term.rows,
        cellW: screen.clientWidth / term.cols,
      };
    };

    // syncing 旗标: container.scroll -> term.scrollToLine 会触发 term.onScroll, 反向同步
    // 需要抑制避免 feedback loop. ref 包起来让两边 handler 共享.
    const syncing = { external: false, internal: false };

    const updateSpacer = (): void => {
      const { cellH, cellW } = getDims();
      if (cellH === 0 || cellW === 0) return;
      const buffer = term.buffer.active;
      // H = buffer.length * cellH 恰好 = (buffer.length - rows) * cellH (scrollback) + rows * cellH (active buffer).
      // 当 host 高于容器 (canvas 溢出), max scrollTop > release threshold, 后段 scrollTop 自然走 sticky release 暴露 canvas 底部.
      spacer.style.height = `${buffer.length * cellH}px`;
      // host 不在 flex 容器里, 需要显式 width/height 才能正确 sticky + 让 canvas 不被压扁
      host.style.width = `${term.cols * cellW}px`;
      host.style.height = `${term.rows * cellH}px`;
      spacer.style.width = host.style.width;
    };

    const ydispToScrollTop = (ydisp: number): number => {
      const { cellH } = getDims();
      return ydisp * cellH;
    };

    const scrollToYdisp = (ydisp: number): void => {
      syncing.internal = true;
      try {
        term.scrollToLine(ydisp);
      } finally {
        syncing.internal = false;
      }
    };

    // scrollback 阶段 (sticky pinned) ydisp 只能整行切换, 每 cellH 才动一次像素粒度明显.
    // 在 xterm 根 .xterm 上挂亚像素 translate 补偿 scrollTop 未满一行的残余, 满一行再 flush ydisp.
    // target 选 .xterm (xterm-host 的第一级子): xterm 内部只动 .xterm 下面的 .xterm-screen, 不碰 .xterm 自己, 不会冲突.
    // release 阶段 ydisp 已饱和, canvas 整体位移由浏览器做 sticky release, 无需 subpixel.
    const applySubpixel = (px: number): void => {
      const xtermRoot = host.querySelector<HTMLElement>(".xterm");
      if (!xtermRoot) return;
      xtermRoot.style.transform = px !== 0 ? `translate3d(0,${-px}px,0)` : "";
    };

    const onContainerScroll = (): void => {
      if (syncing.external) return;
      const { cellH } = getDims();
      if (cellH === 0) return;
      const buffer = term.buffer.active;
      const maxYdisp = Math.max(0, buffer.length - term.rows);
      const pinnedMaxScrollTop = maxYdisp * cellH;
      let wantYdisp: number;
      let subpixel: number;
      if (container.scrollTop >= pinnedMaxScrollTop) {
        // sticky release 阶段: ydisp 已饱和, 不做 subpixel
        wantYdisp = maxYdisp;
        subpixel = 0;
      } else {
        wantYdisp = Math.floor(container.scrollTop / cellH);
        subpixel = container.scrollTop - wantYdisp * cellH;
      }
      applySubpixel(subpixel);
      if (wantYdisp !== buffer.viewportY) {
        scrollToYdisp(wantYdisp);
      }
    };

    const onTermScroll = (): void => {
      if (syncing.internal) return;
      syncing.external = true;
      try {
        container.scrollTop = ydispToScrollTop(term.buffer.active.viewportY);
        // 反向同步后清空 subpixel, 避免遗留
        applySubpixel(0);
      } finally {
        syncing.external = false;
      }
    };

    // 新数据到来时 buffer 可能增长, spacer 需要跟着长; xterm onRender 在每次渲染后触发
    const onRender = (): void => {
      updateSpacer();
    };

    updateSpacer();
    // 初始 pin 到底: scrollTop = max 让 sticky release 同时把 canvas 底部 + active buffer 一起显露
    container.scrollTop = container.scrollHeight;

    container.addEventListener("scroll", onContainerScroll, { passive: true });
    const dispScroll = term.onScroll(onTermScroll);
    const dispRender = term.onRender(onRender);
    // 容器尺寸变化 (侧栏开合 / 键盘弹起) 也要重算 spacer
    const ro = new ResizeObserver(updateSpacer);
    ro.observe(container);
    ro.observe(host);

    return () => {
      container.removeEventListener("scroll", onContainerScroll);
      dispScroll.dispose();
      dispRender.dispose();
      ro.disconnect();
    };
  }, [ready, ptyAutoscale]);

  // autoscale fontSize: 按容器尺寸反推字号, 让 xterm 的 cell 铺满视口.
  // cols/rows 保持 snapshot 原值, 字号变会带动 cellH 变, 驱动 spacer 重算.
  useEffect(() => {
    if (!ready) return;
    const host = xtermHostRef.current;
    const container = containerRef.current;
    const term = terminalRef.current;
    if (!host || !container || !term) return;

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
        className="flex-1 min-h-0 overflow-auto overscroll-contain bg-[#1E1E1E]"
        data-slot="pty-terminal"
      >
        <div
          ref={spacerRef}
          style={{ position: "relative" }}
          data-slot="pty-spacer"
        >
          <div
            ref={xtermHostRef}
            style={{
              position: "sticky",
              top: 0,
              left: 0,
            }}
            data-slot="pty-host"
          />
        </div>
      </div>
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
