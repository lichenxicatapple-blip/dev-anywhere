// InputBar: JSON + PTY 统一输入栏, 1-8 行自撑, 斜杠/@/历史/iOS 键盘适配
// PTY raw-key capture 已放弃 (CONTEXT Addendum D-21), 语义控制走 InputMenu / ChatHeader overflow
// draft + history cursor 为 per-session, 通过 chat-store 跨组件共享
// ArrowUp/Down 历史召回仅 PTY 启用 (JSON 直接点消息气泡引用/复制更直观)
// 命令/文件 token 整体删除: insertedTokens 记录选过的 token, onChange 拦 backspace 跨片段清理
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandEntry } from "@cc-anywhere/shared";
import { Textarea } from "@/components/ui/textarea";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useSessionStore } from "@/stores/session-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import {
  cleanupDeletedToken,
  computeSendDisabled,
  detectPickerMode,
} from "./input-bar-utils";
import { SlashCommandPicker } from "./slash-command-picker";
import { FilePathPicker } from "./file-path-picker";
import { InputMenu } from "./input-menu";
import { SendButton } from "./send-button";
import type { PickerHandle } from "./picker-handle";

const MAX_HISTORY = 100;

interface InputBarProps {
  sessionId: string;
  mode: "json" | "pty";
}

function inputHistoryKey(sessionId: string): string {
  return `cc_inputHistory:${sessionId}`;
}

function loadPersistedHistory(sessionId: string): string[] {
  try {
    const raw = localStorage.getItem(inputHistoryKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((e): e is string => typeof e === "string")
      : [];
  } catch {
    return [];
  }
}

function savePersistedHistory(sessionId: string, history: string[]): void {
  try {
    localStorage.setItem(inputHistoryKey(sessionId), JSON.stringify(history));
  } catch {
    // 存储配额用尽时静默失败, 不阻止发送
  }
}

export function InputBar({ sessionId, mode }: InputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashPickerRef = useRef<PickerHandle>(null);
  const filePickerRef = useRef<PickerHandle>(null);
  const slice = useChatStore((s) => s.bySessionId[sessionId] ?? EMPTY_SLICE);
  const setInputDraft = useChatStore((s) => s.setInputDraft);
  const addUserMessage = useChatStore((s) => s.addUserMessage);
  const setCursor = useChatStore((s) => s.setInputHistoryCursor);
  const resetCursor = useChatStore((s) => s.resetInputHistoryCursor);
  // 发送按钮的 working 态直接读 session.state（proxy 推的单一权威信号）
  const sessionState = useSessionStore(
    (s) => s.sessions.find((x) => x.sessionId === sessionId)?.state,
  );
  const updateSessionState = useSessionStore((s) => s.updateSessionState);
  const bottomOffset = useVisualViewportBottomOffset();
  // 桌面 placeholder 带物理键盘快捷键提示, 手机软键盘上没 Shift / 方向键, 且 320px 会折两行
  const isDesktop = useMediaQuery("(min-width: 768px)");

  const value = slice.inputDraft;
  const isWorking = sessionState === "working";
  const pendingApprovals = slice.pendingApprovals;
  const cursor = slice.inputHistoryCursor;

  const pickerMode = detectPickerMode(value);
  const sendDisabled = computeSendDisabled(mode, isWorking, pendingApprovals);
  const canSend = !sendDisabled && value.trim() !== "";

  // localStorage 持久化的用户消息历史 (按 session key)
  const historyRef = useRef<string[]>([]);
  useEffect(() => {
    historyRef.current = loadPersistedHistory(sessionId);
  }, [sessionId]);

  // 已插入 token (slash 命令 or @路径) 列表, 用于 backspace 整体删除
  const [insertedTokens, setInsertedTokens] = useState<string[]>([]);
  // 选中 slash 命令后的参数提示 (argumentHint), 显示在输入栏上方
  const [argumentHint, setArgumentHint] = useState("");
  // 记录上次的 value, 用于 onChange 对比推断删除方向
  const prevTextRef = useRef(value);

  // 会话切换时重置 token 跟踪 (argumentHint 随之失效, insertedTokens 作废)
  useEffect(() => {
    setInsertedTokens([]);
    setArgumentHint("");
  }, [sessionId]);

  // value 变化时保持 prevTextRef 同步: 覆盖外部触发的 draft 更新
  // (picker onSelect / cursor 历史回放内部已手动同步, 这里是兜底)
  useEffect(() => {
    prevTextRef.current = value;
  }, [value]);

  // cursor 变化 -> 同步 draft 为对应历史条目
  useEffect(() => {
    if (cursor < 0) return;
    const history = historyRef.current;
    if (history.length === 0) return;
    const recalled = history[history.length - 1 - cursor];
    if (typeof recalled === "string") {
      setInputDraft(sessionId, recalled);
      prevTextRef.current = recalled;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  const clearTrackingState = useCallback(() => {
    setInsertedTokens([]);
    setArgumentHint("");
  }, []);

  const send = useCallback(() => {
    // 统一闸门: Enter 快捷键曾绕开 canSend 直调 send, working 中按 Enter 仍会发出
    // 放这里所有入口 (form submit / Enter / SendButton 点击) 都受保护
    if (!canSend) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const relay = relayClientRef;
    if (!relay) return;
    const now = Date.now();
    // 乐观入 store: 立即显示 user bubble + working 态, echo 回来时 dispatcher 不重复追加
    addUserMessage(sessionId, {
      id: `${sessionId}-user-${now}`,
      role: "user",
      text: trimmed,
      isPartial: false,
      timestamp: now,
      toolCalls: [],
    });
    // 乐观翻 session.state="working"：proxy 20~50ms 内会回 session_status 覆写（包括万一没被接受的降级态）
    updateSessionState(sessionId, "working", now);
    relay.sendEnvelope({
      type: "user_input",
      sessionId,
      payload: { text: trimmed },
      seq: 0,
      timestamp: now,
      source: "client",
      version: "1",
    });
    const nextHistory = [...historyRef.current, trimmed].slice(-MAX_HISTORY);
    historyRef.current = nextHistory;
    savePersistedHistory(sessionId, nextHistory);
    setInputDraft(sessionId, "");
    prevTextRef.current = "";
    clearTrackingState();
    resetCursor(sessionId);
  }, [canSend, value, sessionId, setInputDraft, resetCursor, addUserMessage, updateSessionState, clearTrackingState]);

  // onChange 拦截: backspace 删到 token 片段时整体清除, 维护 insertedTokens
  const handleValueChange = (nextVal: string) => {
    const prev = prevTextRef.current;
    const { cleaned, removedToken } = cleanupDeletedToken(
      nextVal,
      prev,
      insertedTokens,
    );
    if (removedToken) {
      setInsertedTokens((tokens) => tokens.filter((t) => t !== removedToken));
      // 删掉的是 slash 命令 (以 "/" 开头), 参数提示也同步清空
      if (removedToken.startsWith("/")) setArgumentHint("");
      setInputDraft(sessionId, cleaned);
      prevTextRef.current = cleaned;
      return;
    }
    setInputDraft(sessionId, nextVal);
    prevTextRef.current = nextVal;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // picker 打开时优先把 ↑↓/Enter 转给 picker, 未消费再走默认流程
    if (pickerMode !== "none") {
      const picker =
        pickerMode === "slash" ? slashPickerRef.current : filePickerRef.current;
      if (picker?.handleKey(e)) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      // IME 组合输入中 (中日韩输入法候选栏), Enter 语义是"确认候选", 让输入法消化
      // 不拦截, 也不 preventDefault, 避免把候选残留在 textarea 里同时又发送
      if (e.nativeEvent.isComposing) return;
      if (pickerMode === "none") {
        e.preventDefault();
        send();
      }
    } else if (e.key === "ArrowUp" && mode === "pty") {
      // 历史翻页: 光标在首行才劫持, 多行编辑让 ↑ 走默认行为
      const caret = e.currentTarget.selectionStart ?? 0;
      if (value.slice(0, caret).includes("\n")) return;
      const len = historyRef.current.length;
      if (len === 0) return;
      e.preventDefault();
      // cursor 范围 [-1, len-1]; -1 为空, 0 为最近一条
      setCursor(sessionId, Math.min(len - 1, cursor + 1));
    } else if (e.key === "ArrowDown" && mode === "pty") {
      const caret = e.currentTarget.selectionStart ?? 0;
      // 多行里的 ↓ 让光标自然移动, 单行或最后一行才走历史
      if (value.slice(caret).includes("\n")) return;
      if (cursor > 0) {
        e.preventDefault();
        setCursor(sessionId, cursor - 1);
      } else if (cursor === 0) {
        e.preventDefault();
        resetCursor(sessionId);
        setInputDraft(sessionId, "");
        prevTextRef.current = "";
        clearTrackingState();
      }
    } else if (e.key === "Escape") {
      if (pickerMode !== "none") {
        e.preventDefault();
        const cleaned = value.replace(/\/\S*$/, "").replace(/@\S*$/, "");
        setInputDraft(sessionId, cleaned);
        prevTextRef.current = cleaned;
      }
    }
  };

  const placeholder = isDesktop
    ? mode === "json"
      ? "输入消息... (Enter 发送，Shift+Enter 换行)"
      : "输入命令... (Enter 发送，↑↓ 方向键支持)"
    : mode === "json"
      ? "输入消息..."
      : "输入命令...";

  return (
    <div
      className="relative w-full"
      style={{ transform: `translateY(-${bottomOffset}px)` }}
      data-slot="input-bar"
      data-mode={mode}
    >
      {pickerMode === "slash" && (
        <SlashCommandPicker
          ref={slashPickerRef}
          filter={value.slice(value.lastIndexOf("/"))}
          onSelect={(cmd: CommandEntry) => {
            // cmd.name 已含前导 "/", 别再拼 `/${name}` 否则出现 //clear
            const token = cmd.name;
            const newVal = value.replace(/\/[^\s]*$/, `${token} `);
            setInputDraft(sessionId, newVal);
            prevTextRef.current = newVal;
            setInsertedTokens((prev) => [...prev, token]);
            setArgumentHint(cmd.argumentHint ?? "");
            textareaRef.current?.focus();
          }}
        />
      )}
      {pickerMode === "file" && (
        <FilePathPicker
          ref={filePickerRef}
          mode="insert"
          filter={value.slice(value.lastIndexOf("@"))}
          onSelect={(path) => {
            // 目录以 "/" 结尾: 不加空格, 让 picker 保持打开继续挑下一级
            // 文件: 加空格关闭 picker, 并把最终 token 记入 insertedTokens 用于整 token 退格
            const isDir = path.endsWith("/");
            const token = `@${path}`;
            const newVal = value.replace(
              /@[^\s]*$/,
              isDir ? token : `${token} `,
            );
            setInputDraft(sessionId, newVal);
            prevTextRef.current = newVal;
            if (!isDir) setInsertedTokens((prev) => [...prev, token]);
            textareaRef.current?.focus();
          }}
        />
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        data-slot="input-card"
        className="flex flex-col w-full rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
      >
        {argumentHint && (
          <div
            className="px-3 pt-1.5 text-[11px] text-muted-foreground font-mono truncate"
            data-slot="input-argument-hint"
          >
            参数: {argumentHint}
          </div>
        )}
        <div className="flex items-center w-full">
          <Textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => handleValueChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="flex-1 resize-none font-normal border-0 bg-transparent shadow-none rounded-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent min-h-0 max-h-60"
            rows={1}
            aria-label={mode === "json" ? "输入聊天消息" : "输入 PTY 命令"}
          />
          <div className="self-stretch relative flex items-center p-1.5 gap-1 before:absolute before:inset-y-2 before:left-0 before:w-px before:bg-gradient-to-b before:from-transparent before:via-border before:to-transparent">
            <InputMenu sessionId={sessionId} mode={mode} />
            <SendButton
              sessionId={sessionId}
              mode={mode}
              isWorking={isWorking}
              canSend={canSend}
              onSend={send}
            />
          </div>
        </div>
      </form>
    </div>
  );
}
