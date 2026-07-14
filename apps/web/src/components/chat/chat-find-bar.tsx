import {
  useLayoutEffect,
  useRef,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChatFindBarProps {
  query: string;
  resultIndex: number;
  resultCount: number;
  focusRequest?: number;
  loading?: boolean;
  onQueryChange: (query: string) => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}

export function ChatFindBar({
  query,
  resultIndex,
  resultCount,
  focusRequest = 0,
  loading = false,
  onQueryChange,
  onPrevious,
  onNext,
  onClose,
}: ChatFindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const hasResults = resultCount > 0;

  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  }, [focusRequest]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onQueryChange(event.target.value);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (event.shiftKey) onPrevious();
    else onNext();
  };

  const resultLabel = getFindResultLabel({
    query,
    resultIndex,
    resultCount,
    loading,
  });

  return (
    <div
      role="search"
      aria-label="在当前会话中查找"
      data-slot="chat-find-bar"
      className="absolute right-2 top-2 z-40 flex h-10 w-[min(22rem,calc(100%-1rem))] items-center gap-1 rounded-md border border-border bg-popover px-1.5 text-popover-foreground shadow-lg"
    >
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="查找"
        aria-label="查找内容"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
        data-slot="chat-find-input"
      />
      <span
        className={cn(
          "flex min-w-14 shrink-0 items-center justify-end gap-1 text-xs tabular-nums",
          query && !hasResults && !loading ? "text-destructive" : "text-muted-foreground",
        )}
        aria-live="polite"
        data-slot="chat-find-results"
      >
        {loading ? <LoaderCircle className="size-3" aria-hidden="true" /> : null}
        {resultLabel}
      </span>
      <FindIconButton
        label="上一个匹配项"
        disabled={!hasResults}
        onClick={onPrevious}
        slot="chat-find-previous"
      >
        <ChevronUp aria-hidden="true" />
      </FindIconButton>
      <FindIconButton
        label="下一个匹配项"
        disabled={!hasResults}
        onClick={onNext}
        slot="chat-find-next"
      >
        <ChevronDown aria-hidden="true" />
      </FindIconButton>
      <FindIconButton label="关闭查找" onClick={onClose} slot="chat-find-close">
        <X aria-hidden="true" />
      </FindIconButton>
    </div>
  );
}

function FindIconButton({
  label,
  disabled = false,
  onClick,
  slot,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  slot: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      data-slot={slot}
      className="flex size-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 [&_svg]:size-4"
    >
      {children}
    </button>
  );
}

export function getFindResultLabel({
  query,
  resultIndex,
  resultCount,
  loading,
}: {
  query: string;
  resultIndex: number;
  resultCount: number;
  loading: boolean;
}): string {
  if (!query) return "";
  if (resultCount === 0) return loading ? "搜索中" : "无结果";
  const safeIndex = Math.min(Math.max(resultIndex, 0), resultCount - 1);
  return `${safeIndex + 1} / ${resultCount}${loading ? "+" : ""}`;
}
