// SlashCommandPicker: 订阅 useCommandStore (动态源, 非硬编码)
// CSS 绝对定位贴在 InputBar 上方, 与 InputBar 同 stacking context (RESEARCH Q10)
import {
  Command,
  CommandList,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";
import { useCommandStore } from "@/stores/command-store";

interface SlashCommandPickerProps {
  filter: string;
  onSelect: (cmdName: string) => void;
}

export function SlashCommandPicker({ filter, onSelect }: SlashCommandPickerProps) {
  const commands = useCommandStore((s) => s.commands);
  const q = filter.toLowerCase().replace(/^\//, "");
  const filtered = q
    ? commands.filter((c) => c.name.toLowerCase().includes(q))
    : commands;

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-2 bg-popover border border-border rounded-md shadow-lg max-h-60 overflow-hidden z-10"
      data-slot="slash-command-picker"
    >
      <Command shouldFilter={false}>
        <CommandList>
          {filtered.length === 0 && <CommandEmpty>没有匹配的命令</CommandEmpty>}
          {filtered.map((cmd) => (
            <CommandItem
              key={cmd.name}
              value={cmd.name}
              onSelect={() => onSelect(cmd.name)}
            >
              <span className="font-mono text-sm">{cmd.name}</span>
              {cmd.description && (
                <span className="ml-auto text-xs text-muted-foreground truncate">
                  {cmd.description}
                </span>
              )}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </div>
  );
}
