// InputBar: JSON + PTY 统一输入栏, 1-8 行自撑, 斜杠/@/历史/iOS 键盘适配
// PTY raw-key capture 已放弃 (CONTEXT Addendum D-21), 语义控制走 SemanticActionPanel
// 跨组件 history/cancel 用 window CustomEvent 桥接, Plan 10-06 Task 1 会迁到 per-session store
import { useCallback, useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { useChatStore } from "@/stores/chat-store";
import { useInputHistory } from "@/hooks/use-input-history";
import { useTextareaAutosize } from "@/hooks/use-textarea-autosize";
import { useVisualViewportBottomOffset } from "@/hooks/use-visual-viewport";
import { computeSendDisabled, detectPickerMode } from "./input-bar-utils";
import { SlashCommandPicker } from "./slash-command-picker";
import { FilePathPicker } from "./file-path-picker";

interface InputBarProps {
  sessionId: string;
  mode: "json" | "pty";
}

interface CustomEventDetail {
  sessionId: string;
}

export function InputBar({ sessionId, mode }: InputBarProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isWorking = useChatStore((s) => s.isWorking);
  const pendingApprovals = useChatStore((s) => s.pendingApprovals);
  const history = useInputHistory(sessionId);
  const bottomOffset = useVisualViewportBottomOffset();

  useTextareaAutosize(textareaRef, value);

  const pickerMode = detectPickerMode(value);
  const sendDisabled = computeSendDisabled(mode, isWorking, pendingApprovals);

  // SemanticActionPanel 通过 custom event 控制 history/cancel
  // Plan 10-06 Task 1 会把 history cursor state 搬到 per-session chat-store 并移除此桥接
  useEffect(() => {
    const onPrev = (e: Event) => {
      const detail = (e as CustomEvent<CustomEventDetail>).detail;
      if (detail?.sessionId !== sessionId) return;
      if (value !== "") return;
      const prev = history.recallPrev();
      if (prev != null) setValue(prev);
    };
    const onNext = (e: Event) => {
      const detail = (e as CustomEvent<CustomEventDetail>).detail;
      if (detail?.sessionId !== sessionId) return;
      const nx = history.recallNext();
      if (nx != null) setValue(nx);
    };
    const onCancel = (e: Event) => {
      const detail = (e as CustomEvent<CustomEventDetail>).detail;
      if (detail?.sessionId !== sessionId) return;
      setValue("");
      history.reset();
    };
    window.addEventListener("cc:input-history-prev", onPrev);
    window.addEventListener("cc:input-history-next", onNext);
    window.addEventListener("cc:input-cancel", onCancel);
    return () => {
      window.removeEventListener("cc:input-history-prev", onPrev);
      window.removeEventListener("cc:input-history-next", onNext);
      window.removeEventListener("cc:input-cancel", onCancel);
    };
  }, [sessionId, value, history]);

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
    history.push(trimmed);
    setValue("");
  }, [value, sessionId, history]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (pickerMode === "none") {
        e.preventDefault();
        send();
      }
    } else if (e.key === "ArrowUp" && value === "" && mode === "json") {
      e.preventDefault();
      const prev = history.recallPrev();
      if (prev != null) setValue(prev);
    } else if (e.key === "ArrowDown" && mode === "json") {
      const nx = history.recallNext();
      if (nx != null) {
        e.preventDefault();
        setValue(nx);
      }
    } else if (e.key === "Escape") {
      if (pickerMode !== "none") {
        e.preventDefault();
        setValue(value.replace(/\/\S*$/, "").replace(/@\S*$/, ""));
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
            setValue(value.replace(/\/[^\s]*$/, `/${name} `));
            textareaRef.current?.focus();
          }}
        />
      )}
      {pickerMode === "file" && (
        <FilePathPicker
          mode="insert"
          filter={value.slice(value.lastIndexOf("@"))}
          onSelect={(path) => {
            setValue(value.replace(/@[^\s]*$/, `@${path} `));
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
          onChange={(e) => setValue(e.target.value)}
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
