// 统一输入栏组件，PTY 和 JSON 模式共用，集成 picker 触发和引用预览
import { useState, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import { View, Text, Input } from "@tarojs/components";
import type { QuotedMessage } from "@/stores/chat-store";
import "./index.css";

export interface InputBarHandle {
  // 替换整个输入为 /{name} ，注册 token 用于原子删除
  replaceCommand: (name: string, argumentHint?: string) => void;
  // 找到最后一个 @，从该位置替换为 @{path} ，注册 token
  insertFileRef: (path: string) => void;
  focus: () => void;
}

export function computeSendDisabled(
  mode: "pty" | "json",
  isWorking: boolean,
  pendingApprovals: Array<{ status: string }>,
): { disabled: boolean; reason?: string } {
  if (mode === "pty") return { disabled: false };
  if (isWorking) return { disabled: true };
  if (pendingApprovals.some((a) => a.status === "pending"))
    return { disabled: true, reason: "Waiting for tool approval..." };
  return { disabled: false };
}

// @ 在句首或前面有空格时才算有效触发，@ 后面有空格说明文件引用已完成
export function hasValidAt(val: string): boolean {
  const idx = val.lastIndexOf("@");
  if (idx < 0) return false;
  if (idx > 0 && val[idx - 1] !== " ") return false;
  const afterAt = val.slice(idx + 1);
  return !afterAt.includes(" ");
}

export type PickerMode = "none" | "slash" | "file";

export function detectPickerMode(val: string): PickerMode {
  if (!val) return "none";
  if (hasValidAt(val)) return "file";
  if (val.startsWith("/") && !val.slice(1).includes(" ")) return "slash";
  return "none";
}

// 退格删除已插入 token 时，清理残留片段并返回清理后的文本
export function cleanupDeletedToken(
  val: string,
  prev: string,
  insertedTokens: string[],
): { cleaned: string; removedToken: string | null } {
  if (val.length >= prev.length || insertedTokens.length === 0) {
    return { cleaned: val, removedToken: null };
  }
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
      return { cleaned, removedToken: token };
    }
  }
  return { cleaned: val, removedToken: null };
}

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

export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({
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
}, ref) {
  const [inputText, setInputText] = useState("");
  const [insertedTokens, setInsertedTokens] = useState<string[]>([]);
  const [inputFocus, setInputFocus] = useState(false);
  const prevTextRef = useRef("");

  useImperativeHandle(ref, () => ({
    replaceCommand: (name: string) => {
      const text = `${name} `;
      const token = name;
      setInputText(text);
      setInsertedTokens(prev => [...prev, token]);
      prevTextRef.current = text;
      onPickerModeChange?.("none");
      onFilterChange?.(text);
    },
    insertFileRef: (path: string) => {
      const token = `@${path}`;
      const replacement = `${token} `;
      setInputText(prev => {
        const atIdx = prev.lastIndexOf("@");
        const newText = atIdx >= 0 ? prev.slice(0, atIdx) + replacement : prev + replacement;
        prevTextRef.current = newText;
        onPickerModeChange?.("none");
        onFilterChange?.(newText);
        return newText;
      });
      setInsertedTokens(prev => [...prev, token]);
    },
    focus: () => {
      setInputFocus(true);
    },
  }), [onPickerModeChange, onFilterChange]);

  const handleInput = useCallback(
    (e: { detail: { value: string } }) => {
      const val: string = e.detail.value;
      const prev = prevTextRef.current;

      const { cleaned, removedToken } = cleanupDeletedToken(val, prev, insertedTokens);
      if (removedToken) {
        setInsertedTokens((tokens) => tokens.filter((x) => x !== removedToken));
        setInputText(cleaned);
        prevTextRef.current = cleaned;
        onPickerModeChange?.(detectPickerMode(cleaned));
        onFilterChange?.(cleaned);
        return;
      }

      setInputText(val);
      prevTextRef.current = val;
      onPickerModeChange?.(detectPickerMode(val));
      onFilterChange?.(val);
    },
    [insertedTokens, onPickerModeChange, onFilterChange],
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
        <View className="input-bar-menu-btn" onClick={onMenuPress}>
          <Text className="input-bar-menu-btn-text">{"\u00B7\u00B7\u00B7"}</Text>
        </View>
        <View
          className={`input-bar-send-btn ${canSend ? "active" : "disabled"}`}
          onClick={handleSend}
        >
          <Text className="input-bar-send-icon">{"\u2191"}</Text>
        </View>
      </View>
    </View>
  );
});
