// 斜杠命令选择器：输入 / 触发，实时过滤命令列表
import { useMemo } from "react";
import { View, Text, ScrollView } from "@tarojs/components";
import type { CommandEntry } from "@cc-anywhere/shared";
import "./index.css";

interface SlashCommandPickerProps {
  commands: CommandEntry[];
  filter: string;
  onSelect: (cmd: CommandEntry) => void;
  visible: boolean;
}

export function SlashCommandPicker({
  commands,
  filter,
  onSelect,
  visible,
}: SlashCommandPickerProps) {
  const filtered = useMemo(() => {
    const q = filter.toLowerCase().replace(/^\//, "");
    if (!q) return commands;
    return commands.filter((c) => c.name.toLowerCase().includes(q));
  }, [commands, filter]);

  if (!visible) return null;

  return (
    <View className="slash-picker-panel">
      <View className="slash-picker-header">
        <Text className="slash-picker-title">Commands</Text>
        <Text className="slash-picker-count">{filtered.length}</Text>
      </View>
      <ScrollView className="slash-picker-scroll" scrollY>
        {filtered.length === 0 && (
          <View className="slash-picker-empty">
            <Text className="slash-picker-empty-text">No matching commands</Text>
          </View>
        )}
        {filtered.map((cmd) => (
          <View
            key={cmd.name}
            className="slash-picker-item"
            onClick={() => onSelect(cmd)}
          >
            <View className="slash-picker-item-top">
              <Text className="slash-picker-item-name">{cmd.name}</Text>
              <Text className="slash-picker-item-source">{cmd.source}</Text>
            </View>
            <Text className="slash-picker-item-desc">{cmd.description}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
