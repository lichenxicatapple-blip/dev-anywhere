import { useState, type RefObject } from "react";
import { toast } from "@/components/toast";
import { cn } from "@/lib/utils";

interface TerminalDimensionInputProps {
  axis: "cols" | "rows";
  label: string;
  value: number | undefined;
  min: number;
  max: number;
  disabled: boolean;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onCommit: (value: number) => void;
}

export function TerminalDimensionInput({
  axis,
  label,
  value,
  min,
  max,
  disabled,
  returnFocusRef,
  onCommit,
}: TerminalDimensionInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const invalidDimensionMessage = `请输入 ${min}–${max} 之间的整数`;

  function cancel() {
    setDraft(null);
    setEdited(false);
    setInvalid(false);
  }

  function readEditedDimension() {
    if (disabled || !edited || draft === null) return undefined;
    const text = draft.trim();
    const next = Number(text);
    return /^\d+$/.test(text) && Number.isSafeInteger(next) && next >= min && next <= max
      ? next
      : null;
  }

  function commitOnBlur() {
    const next = readEditedDimension();
    cancel();
    if (next === null) toast.error(invalidDimensionMessage);
    else if (next !== undefined && next !== value) onCommit(next);
  }

  return (
    <input
      type="text"
      inputMode="numeric"
      enterKeyHint="done"
      pattern="[0-9]*"
      aria-label={`设置${label}`}
      aria-invalid={invalid}
      data-slot={`chat-menu-${axis}-value`}
      data-terminal-dimension-input=""
      data-editing={draft !== null ? "true" : "false"}
      className={cn(
        "h-[22px] w-9 rounded-[5px] border border-transparent bg-transparent px-0.5 text-center text-sm font-medium leading-none tabular-nums text-foreground outline-none hover:bg-muted/45 focus:border-ring focus:bg-background disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:focus:text-base",
        invalid && "border-destructive focus:border-destructive",
      )}
      disabled={disabled}
      value={draft ?? value?.toString() ?? ""}
      placeholder="—"
      autoComplete="off"
      spellCheck={false}
      onFocus={(event) => {
        setDraft(event.currentTarget.value);
        setEdited(false);
        event.currentTarget.select();
      }}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
        setEdited(true);
        setInvalid(false);
      }}
      onBlur={commitOnBlur}
      onKeyDown={(event) => {
        // Editing keys and digits belong to the input, not menu navigation/typeahead.
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          if (readEditedDimension() === null) {
            toast.error(invalidDimensionMessage);
            setInvalid(true);
            return;
          }
          // Moving focus commits through onBlur, just like clicking another menu control.
          returnFocusRef?.current?.focus({ preventScroll: true });
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
        }
      }}
    />
  );
}
