// 统一输入栏组件，PTY 和 JSON 模式共用，集成 picker 触发和引用预览
import { useState, useCallback, useRef } from "react";
import { View, Text, Input } from "@tarojs/components";
import type { QuotedMessage } from "@/stores/chat-store";
import "./index.css";

export function computeSendDisabled(
  mode: "pty" | "json",
  isWorking: boolean,
  pendingApprovals: Array<{ status: string }>,
): { disabled: boolean; reason?: string } {
  if (mode === "pty") return { disabled: false };
  if (isWorking) return { disabled: true, reason: "Claude is working..." };
  if (pendingApprovals.some((a) => a.status === "pending"))
    return { disabled: true, reason: "Waiting for tool approval..." };
  return { disabled: false };
}

// @ 在句首或前面有空格时才算有效触发，@ 后面有空格说明文件引用已完成
function hasValidAt(val: string): boolean {
  const idx = val.lastIndexOf("@");
  if (idx < 0) return false;
  if (idx > 0 && val[idx - 1] !== " ") return false;
  const afterAt = val.slice(idx + 1);
  return !afterAt.includes(" ");
}

export type PickerMode = "none" | "slash" | "file";

interface InputBarProps {
  onSend: (text: string, quote?: QuotedMessage) => void;
  disabled: boolean;
  disabledReason?: string;
  mode: "pty" | "json";
  onMenuPress: () => void;
  onPickerModeChange?: (mode: PickerMode) => void;
  onFilterChange?: (filter: string) => void;
  quotedMessage?: QuotedMessage | null;
  onCancelQuote?: () => void;
  argumentHint?: string;
}

export function InputBar({
  onSend,
  disabled,
  disabledReason,
  mode,
  onMenuPress,
  onPickerModeChange,
  onFilterChange,
  quotedMessage,
  onCancelQuote,
  argumentHint,
}: InputBarProps) {
  const [inputText, setInputText] = useState("");
  const [insertedTokens, setInsertedTokens] = useState<string[]>([]);
  const [inputFocus, setInputFocus] = useState(false);
  const prevTextRef = useRef("");

  const detectPickerMode = useCallback(
    (val: string): PickerMode => {
      if (!val) return "none";
      if (hasValidAt(val)) return "file";
      if (val.startsWith("/") && !val.slice(1).includes(" ")) return "slash";
      return "none";
    },
    [],
  );

  const handleInput = useCallback(
    (e: { detail: { value: string } }) => {
      const val: string = e.detail.value;
      const prev = prevTextRef.current;

      // 检测退格：文本变短且某个已知 token 被部分删除，整体移除该 token
      if (val.length < prev.length && insertedTokens.length > 0) {
        for (const token of insertedTokens) {
          if (prev.includes(token) && !val.includes(token)) {
            let cleaned = val;
            for (let len = token.length - 1; len > 0; len--) {
              const fragment = token.slice(0, len);
              if (cleaned.endsWith(fragment)) {
                cleaned = cleaned.slice(0, -fragment.length);
                if (cleaned.endsWith(" ")) cleaned = cleaned.slice(0, -1);
                break;
              }
            }
            setInsertedTokens((tokens) => tokens.filter((x) => x !== token));
            setInputText(cleaned);
            prevTextRef.current = cleaned;

            const newMode = detectPickerMode(cleaned);
            onPickerModeChange?.(newMode);
            onFilterChange?.(cleaned);
            return;
          }
        }
      }

      setInputText(val);
      prevTextRef.current = val;

      const newMode = detectPickerMode(val);
      onPickerModeChange?.(newMode);
      onFilterChange?.(val);
    },
    [insertedTokens, detectPickerMode, onPickerModeChange, onFilterChange],
  );

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    if (disabled && mode === "json") return;

    let finalText = text;
    if (quotedMessage) {
      finalText = `<quote from="${quotedMessage.from}">${quotedMessage.text}</quote>\n${text}`;
    }

    setInputText("");
    setInsertedTokens([]);
    prevTextRef.current = "";
    onPickerModeChange?.("none");
    onFilterChange?.("");
    onCancelQuote?.();
    onSend(finalText, quotedMessage ?? undefined);
  }, [
    inputText,
    disabled,
    mode,
    quotedMessage,
    onSend,
    onPickerModeChange,
    onFilterChange,
    onCancelQuote,
  ]);

  const canSend = inputText.trim().length > 0 && !(disabled && mode === "json");

  return (
    <View className="input-bar">
      {disabled && disabledReason && (
        <View className="input-bar-reason">
          <Text className="input-bar-reason-text">{disabledReason}</Text>
        </View>
      )}
      {argumentHint && (
        <View className="input-bar-hint">
          <Text className="input-bar-hint-text">{argumentHint}</Text>
        </View>
      )}
      <View className="input-bar-row">
        <View className="input-bar-menu-btn" onClick={onMenuPress}>
          <Text className="input-bar-menu-btn-text">{"\u00B7\u00B7\u00B7"}</Text>
        </View>
        <Input
          className="input-bar-field"
          value={inputText}
          focus={inputFocus}
          onInput={handleInput}
          onConfirm={handleSend}
          onBlur={() => setInputFocus(false)}
          placeholder={argumentHint || "Input message..."}
          confirmType="send"
          adjustPosition
        />
        <View
          className={`input-bar-send-btn ${canSend ? "active" : "disabled"}`}
          onClick={handleSend}
        >
          <Text className="input-bar-send-icon">{"\u2191"}</Text>
        </View>
      </View>
    </View>
  );
}
