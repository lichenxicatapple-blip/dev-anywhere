// 统一输入栏组件，PTY 和 JSON 模式共用
import { useState, useCallback } from "react";
import { View, Text, Input } from "@tarojs/components";
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

interface InputBarProps {
  onSend: (text: string) => void;
  disabled: boolean;
  disabledReason?: string;
  mode: "pty" | "json";
  onMenuPress: () => void;
}

export function InputBar({
  onSend,
  disabled,
  disabledReason,
  mode,
  onMenuPress,
}: InputBarProps) {
  const [inputText, setInputText] = useState("");

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text) return;
    if (disabled && mode === "json") return;
    setInputText("");
    onSend(text);
  }, [inputText, disabled, mode, onSend]);

  const canSend = inputText.trim().length > 0 && !(disabled && mode === "json");

  return (
    <View className="input-bar">
      {disabled && disabledReason && (
        <View className="input-bar-reason">
          <Text className="input-bar-reason-text">{disabledReason}</Text>
        </View>
      )}
      <View className="input-bar-row">
        <View className="input-bar-menu-btn" onClick={onMenuPress}>
          <Text className="input-bar-menu-btn-text">{"\u00B7\u00B7\u00B7"}</Text>
        </View>
        <Input
          className="input-bar-field"
          value={inputText}
          onInput={(e) => setInputText(e.detail.value)}
          onConfirm={handleSend}
          placeholder="Input message..."
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
