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
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";

interface ChatPtyViewProps {
  sessionId: string;
}

export function ChatPtyView({ sessionId }: ChatPtyViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const [ready, setReady] = useState(false);
  const pendingApprovals = useChatStore(
    (s) => s.bySessionId[sessionId]?.pendingApprovals ?? EMPTY_SLICE.pendingApprovals,
  );
  const pending = pendingApprovals.find((a) => a.status === "pending");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposeFn: (() => void) | null = null;
    let unsubBinary: (() => void) | null = null;
    let unsubSnapshot: (() => void) | null = null;
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

      unsubSnapshot = relay.onMessage((msg) => {
        const m = msg as Record<string, unknown>;
        if (m.type !== "session_snapshot" || m.sessionId !== sessionId) return;
        const term = terminalRef.current;
        if (!term) return;
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
      });

      ws.send(JSON.stringify({ type: "session_subscribe", sessionId }));
    })();

    return () => {
      cancelled = true;
      unsubBinary?.();
      unsubSnapshot?.();
      disposeFn?.();
      terminalRef.current = null;
      serializeRef.current = null;
    };
  }, [sessionId]);

  return (
    <div className="flex flex-col h-full relative" data-slot="chat-pty-view">
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden bg-[#1E1E1E]"
        data-slot="pty-terminal"
      />
      {!ready && (
        <div
          className="absolute top-0 left-0 right-0 h-8 flex items-center justify-center bg-card/60 text-xs text-muted-foreground"
          data-slot="pty-connecting"
        >
          PTY 正在连接...
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
      <div
        className="h-7 px-3 flex items-center text-xs text-muted-foreground border-t border-border bg-card"
        data-slot="pty-status-line"
      >
        {ready ? "就绪" : "PTY 正在连接..."}
      </div>
    </div>
  );
}
