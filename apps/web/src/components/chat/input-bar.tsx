// InputBar: JSON + PTY 统一输入栏, 1-8 行自撑, 斜杠/@/历史/iOS 键盘适配
// PTY raw-key capture 已放弃 (CONTEXT Addendum D-21), 语义控制走 SemanticActionPanel
// draft + history cursor 为 per-session, 通过 chat-store 跨组件共享 (SemanticActionPanel 写, 此组件读)
import { useCallback, useEffect, useRef } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { EMPTY_SLICE, useChatStore } from "@/stores/chat-store";
import { useTextareaAutosize } from "@/hooks/use-textarea-autosize";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import { computeSendDisabled, detectPickerMode } from "./input-bar-utils";
import { SlashCommandPicker } from "./slash-command-picker";
import { FilePathPicker } from "./file-path-picker";

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
  const slice = useChatStore((s) => s.bySessionId[sessionId] ?? EMPTY_SLICE);
  const setInputDraft = useChatStore((s) => s.setInputDraft);
  const moveCursor = useChatStore((s) => s.moveInputHistoryCursor);
  const resetCursor = useChatStore((s) => s.resetInputHistoryCursor);
  const bottomOffset = useVisualViewportBottomOffset();

  const value = slice.inputDraft;
  const isWorking = slice.isWorking;
  const pendingApprovals = slice.pendingApprovals;
  const cursor = slice.inputHistoryCursor;

  useTextareaAutosize(textareaRef, value);

  const pickerMode = detectPickerMode(value);
  const sendDisabled = computeSendDisabled(mode, isWorking, pendingApprovals);

  // localStorage 持久化的用户消息历史 (按 session key)
  // 与 slice.messages.filter(role=user) 的区别: 历史条目是"曾经发送过的 draft 文本", 不依赖 messages 是否被 clear
  const historyRef = useRef<string[]>([]);
  useEffect(() => {
    historyRef.current = loadPersistedHistory(sessionId);
  }, [sessionId]);

  // cursor 变化 -> 同步 draft 为对应历史条目; cursor=-1 不动 draft (由 resetCursor 的调用方自行清空)
  useEffect(() => {
    if (cursor < 0) return;
    const history = historyRef.current;
    if (history.length === 0) return;
    const recalled = history[history.length - 1 - cursor];
    if (typeof recalled === "string") {
      setInputDraft(sessionId, recalled);
    }
    // 故意只依赖 cursor; sessionId 变化时上面的 effect 会刷新 historyRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  const send = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    const relay = relayClientRef;
    if (!relay) return;
    // user_input 是完整 MessageEnvelope (非 RelayControl), 需补 seq/timestamp/source/version
    relay.sendEnvelope({
      type: "user_input",
      sessionId,
      payload: { text: trimmed },
      seq: 0,
      timestamp: Date.now(),
      source: "client",
      version: "1",
    });
    const nextHistory = [...historyRef.current, trimmed].slice(-MAX_HISTORY);
    historyRef.current = nextHistory;
    savePersistedHistory(sessionId, nextHistory);
    setInputDraft(sessionId, "");
    resetCursor(sessionId);
  }, [value, sessionId, setInputDraft, resetCursor]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (pickerMode === "none") {
        e.preventDefault();
        send();
      }
    } else if (e.key === "ArrowUp" && value === "" && mode === "json") {
      e.preventDefault();
      moveCursor(sessionId, +1);
    } else if (e.key === "ArrowDown" && mode === "json") {
      if (cursor > 0) {
        e.preventDefault();
        moveCursor(sessionId, -1);
      } else if (cursor === 0) {
        e.preventDefault();
        resetCursor(sessionId);
        setInputDraft(sessionId, "");
      }
    } else if (e.key === "Escape") {
      if (pickerMode !== "none") {
        e.preventDefault();
        setInputDraft(
          sessionId,
          value.replace(/\/\S*$/, "").replace(/@\S*$/, ""),
        );
      }
    }
  };

  const placeholder =
    mode === "json"
      ? "输入消息... (Enter 发送，Shift+Enter 换行)"
      : "输入命令... (Enter 发送，↑↓ 方向键支持)";

  return (
    <div
      className="flex-1 relative"
      style={{ transform: `translateY(-${bottomOffset}px)` }}
      data-slot="input-bar"
      data-mode={mode}
    >
      {pickerMode === "slash" && (
        <SlashCommandPicker
          filter={value.slice(value.lastIndexOf("/"))}
          onSelect={(name) => {
            setInputDraft(sessionId, value.replace(/\/[^\s]*$/, `/${name} `));
            textareaRef.current?.focus();
          }}
        />
      )}
      {pickerMode === "file" && (
        <FilePathPicker
          mode="insert"
          filter={value.slice(value.lastIndexOf("@"))}
          onSelect={(path) => {
            setInputDraft(sessionId, value.replace(/@[^\s]*$/, `@${path} `));
            textareaRef.current?.focus();
          }}
        />
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="flex items-end gap-2"
      >
        <Textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setInputDraft(sessionId, e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="flex-1 resize-none font-normal"
          rows={1}
          aria-label={mode === "json" ? "输入聊天消息" : "输入 PTY 命令"}
        />
        <Button
          type="submit"
          size="icon"
          disabled={sendDisabled || value.trim() === ""}
          aria-label="发送"
          data-slot="send-button"
        >
          <Send aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}
