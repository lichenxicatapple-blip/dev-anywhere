// SlashCommandPicker: 订阅 useCommandStore (动态源, 非硬编码)
// 键盘: InputBar 通过 ref.handleKey 转发 ↑↓/Enter; cmdk 的 `value` prop 控制高亮 + 自动 scroll into view
// CSS 绝对定位贴在 InputBar 上方, 与 InputBar 同 stacking context (RESEARCH Q10)
import { forwardRef, useImperativeHandle, useMemo, useState, useEffect } from "react";
import { Command, CommandList, CommandItem, CommandEmpty } from "@/components/ui/command";
import { useCommandStore } from "@/stores/command-store";
import type { CommandEntry } from "@dev-anywhere/shared";
import type { PickerHandle } from "./picker-handle";

interface SlashCommandPickerProps {
  filter: string;
  // 回传整个 CommandEntry 让 InputBar 能顺便拿 argumentHint
  onSelect: (cmd: CommandEntry) => void;
}

export const SlashCommandPicker = forwardRef<PickerHandle, SlashCommandPickerProps>(
  function SlashCommandPicker({ filter, onSelect }, ref) {
    const commands = useCommandStore((s) => s.commands);
    const filtered = useMemo(() => {
      const q = filter.toLowerCase().replace(/^\//, "");
      return q ? commands.filter((c) => c.name.toLowerCase().includes(q)) : commands;
    }, [commands, filter]);

    const [index, setIndex] = useState(0);
    // filter 变化时重置到首项, 避免 index 指向被过滤掉的条目
    useEffect(() => setIndex(0), [filter]);
    // filtered 变短时 clamp, 防止越界
    useEffect(() => {
      if (index >= filtered.length && filtered.length > 0) setIndex(filtered.length - 1);
    }, [filtered.length, index]);

    useImperativeHandle(
      ref,
      () => ({
        handleKey(e) {
          if (filtered.length === 0) return false;
          if (e.key === "ArrowDown") {
            setIndex((i) => Math.min(filtered.length - 1, i + 1));
            return true;
          }
          if (e.key === "ArrowUp") {
            setIndex((i) => Math.max(0, i - 1));
            return true;
          }
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            onSelect(filtered[index]);
            return true;
          }
          return false;
        },
      }),
      [filtered, index, onSelect],
    );

    const selectedValue = filtered[index]?.name;

    return (
      <div
        className="absolute bottom-full left-0 right-0 mb-2 bg-popover border border-border rounded-md shadow-lg z-10 overflow-hidden"
        data-slot="slash-command-picker"
      >
        <Command shouldFilter={false} value={selectedValue}>
          <CommandList className="max-h-60">
            {filtered.length === 0 && <CommandEmpty>没有匹配的命令</CommandEmpty>}
            {filtered.map((cmd) => (
              <CommandItem
                key={cmd.name}
                value={cmd.name}
                onSelect={() => onSelect(cmd)}
                // --accent 和 --popover 同为 #2D2D2D, 默认 data-[selected=true]:bg-accent
                // 在 picker 底色上不可见; 用 primary 15% 混色保持跟 file picker 一致
                className="min-h-11 py-2 data-[selected=true]:bg-[color-mix(in_srgb,var(--primary)_15%,transparent)] md:min-h-0 md:py-1.5"
              >
                <span className="font-mono text-sm whitespace-nowrap shrink-0">{cmd.name}</span>
                {cmd.description && (
                  <span className="ml-auto min-w-0 text-xs text-muted-foreground truncate">
                    {cmd.description}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </div>
    );
  },
);
