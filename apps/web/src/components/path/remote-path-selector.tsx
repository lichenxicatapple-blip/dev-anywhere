import {
  type AriaAttributes,
  type KeyboardEventHandler,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { FolderOpen } from "lucide-react";
import { FilePathPicker } from "@/components/chat/file-path-picker";
import type { PickerHandle } from "@/components/chat/picker-handle";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useFileStore } from "@/stores/file-store";
import { describeCurrentClientDevice } from "@/lib/client-device";
import { cn } from "@/lib/utils";
import {
  normalizeRemoteAbsolutePath,
  remoteParentDirectory,
  remotePathSeparator,
  withTrailingSeparator,
} from "@/lib/remote-path";

export type RemotePathSelectionKind = "file" | "directory" | "file-or-directory";

export interface RemotePathSelectorProps {
  value: string;
  onValueChange: (path: string) => void;
  selectionKind: RemotePathSelectionKind;
  fileExtensions?: readonly string[];
  includeHidden?: boolean;
  onCreateDirectory?: (absolutePath: string) => Promise<string | null>;
  disabled?: boolean;
  placeholder?: string;
  label: ReactNode;
  labelActions?: ReactNode;
  id?: string;
  name?: string;
  required?: boolean;
  autoFocus?: boolean;
  "aria-describedby"?: string;
  "aria-invalid"?: AriaAttributes["aria-invalid"];
  "data-slot"?: string;
  className?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
}

function pickerStart(
  value: string,
  homePath: string,
  selectionKind: RemotePathSelectionKind,
): string {
  const absolute = absoluteInputPath(value, homePath);
  if (!absolute) return homePath;
  if (selectionKind === "file") return withTrailingSeparator(remoteParentDirectory(absolute));
  return selectionKind === "directory" ? withTrailingSeparator(absolute) : absolute;
}

function absoluteInputPath(path: string, homePath: string): string {
  const normalized = normalizeRemoteAbsolutePath(path, homePath);
  if (!normalized) return "";
  const trailingSeparator =
    path.endsWith("/") || (remotePathSeparator(normalized) === "\\" && path.endsWith("\\"));
  return trailingSeparator ? withTrailingSeparator(normalized) : normalized;
}

export function RemotePathSelector({
  value,
  onValueChange,
  selectionKind,
  fileExtensions,
  includeHidden = false,
  onCreateDirectory,
  disabled = false,
  placeholder = "选择路径",
  label,
  labelActions,
  id,
  name,
  required,
  autoFocus,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  "data-slot": dataSlot,
  className,
  onKeyDown,
}: RemotePathSelectorProps) {
  const generatedId = useId();
  const controlId = id ?? `remote-path-${generatedId}`;
  const labelId = `${controlId}-label`;
  const homePath = useFileStore((state) => state.homePath);
  const coarsePointer = useMediaQuery("(pointer: coarse), (hover: none)");
  const deviceKind = describeCurrentClientDevice().deviceKind;
  const nativeTouchSurface = coarsePointer || deviceKind === "phone" || deviceKind === "tablet";
  const [open, setOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState(() => pickerStart(value, homePath, selectionKind));
  const [draft, setDraft] = useState(value);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<PickerHandle>(null);

  useEffect(() => {
    if (open || document.activeElement === inputRef.current || draft === value) return;
    setDraft(value);
  }, [draft, open, value]);

  useEffect(() => {
    if (!open) return;

    function closeOnOutsideClick(event: MouseEvent): void {
      const root = rootRef.current;
      const target = event.target;
      // React may replace the clicked directory row before this document listener runs.
      // composedPath retains the original ancestry, so an inside click stays inside.
      if (
        root &&
        (event.composedPath().includes(root) || (target instanceof Node && root.contains(target)))
      ) {
        return;
      }
      setOpen(false);
      setDraft(value);
    }

    // Let the clicked control finish its own action before an inline picker changes layout.
    // Closing on pointerdown could move mobile buttons away before their click was delivered.
    document.addEventListener("click", closeOnOutsideClick);
    return () => document.removeEventListener("click", closeOnOutsideClick);
  }, [open, value]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setDraft(value);
  }, [disabled, value]);

  const canSelectCurrentDirectory = selectionKind !== "file";

  function openPicker(): void {
    if (disabled) return;
    const start = pickerStart(value, homePath, selectionKind);
    setBrowsePath(start);
    setDraft(value);
    setOpen(true);
  }

  function closePicker(): void {
    setOpen(false);
    setDraft(value);
  }

  function commitAbsolutePath(path: string): void {
    const absolute = absoluteInputPath(path, homePath);
    if (!absolute) return;
    setBrowsePath(absolute);
    setDraft(absolute);
    onValueChange(absolute);
    setOpen(false);
  }

  function navigate(path: string): void {
    const absolute = absoluteInputPath(path, homePath);
    if (!absolute) return;
    setBrowsePath(absolute);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (open && pickerRef.current?.handleKey(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Escape" && open) {
      event.preventDefault();
      closePicker();
      return;
    }
    onKeyDown?.(event);
  }

  const picker = open ? (
    <div className={cn(nativeTouchSurface && "mt-2")} data-slot="remote-path-browser">
      <FilePathPicker
        ref={pickerRef}
        mode="select"
        placement={nativeTouchSurface ? "inline" : "floating"}
        filter={browsePath}
        dirsOnly={selectionKind === "directory"}
        fileExtensions={fileExtensions}
        includeHidden={includeHidden}
        autoHighlightFirst={!nativeTouchSurface}
        title={placeholder}
        onNavigate={navigate}
        onSelect={commitAbsolutePath}
        onSelectCurrentDirectory={canSelectCurrentDirectory ? commitAbsolutePath : undefined}
        onCreateDirectory={onCreateDirectory}
      />
    </div>
  ) : null;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span id={labelId} className="min-w-0 text-sm">
          {label}
        </span>
        {labelActions ? (
          <div className="flex shrink-0 items-center gap-4">{labelActions}</div>
        ) : null}
      </div>
      <div
        ref={rootRef}
        className="relative min-w-0"
        onBlur={(event) => {
          if (!open || nativeTouchSurface) return;
          const nextFocus = event.relatedTarget;
          if (nextFocus instanceof Node && event.currentTarget.contains(nextFocus)) return;
          window.setTimeout(() => {
            if (!rootRef.current?.contains(document.activeElement)) closePicker();
          }, 0);
        }}
      >
        <div className="relative flex min-w-0 items-center">
          <input
            ref={inputRef}
            id={controlId}
            type="text"
            aria-labelledby={labelId}
            aria-describedby={ariaDescribedBy}
            aria-invalid={ariaInvalid}
            name={name}
            required={required}
            autoFocus={autoFocus && !nativeTouchSurface}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={disabled}
            value={draft}
            data-slot={dataSlot}
            data-path-control="input"
            onFocus={() => {
              if (nativeTouchSurface) setOpen(false);
              else openPicker();
            }}
            onBlur={() => setDraft(value)}
            onKeyDown={handleKeyDown}
            onChange={(event) => {
              const path = event.target.value;
              const absolute = absoluteInputPath(path, homePath);
              setDraft(path);
              setBrowsePath(absolute || homePath);
              onValueChange(absolute || path);
              setOpen(!nativeTouchSurface);
            }}
            onPaste={(event) => {
              // Windows Explorer's “Copy as path” includes surrounding quotes.
              const pasted = event.clipboardData.getData("text").trim();
              const unquoted =
                pasted.startsWith('"') && pasted.endsWith('"') ? pasted.slice(1, -1) : pasted;
              const absolute = absoluteInputPath(unquoted, homePath);
              if (!absolute) return;
              event.preventDefault();
              setDraft(absolute);
              setBrowsePath(absolute);
              onValueChange(absolute);
              setOpen(!nativeTouchSurface);
            }}
            placeholder={placeholder}
            className="min-h-11 min-w-0 w-full rounded-md border border-border bg-input pl-3 pr-12 font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 md:h-9 md:min-h-0 md:text-sm"
          />
          <button
            type="button"
            aria-label={typeof label === "string" ? `浏览${label}` : "浏览路径"}
            aria-expanded={open}
            aria-controls={`${controlId}-browser`}
            disabled={disabled}
            data-slot="remote-path-browse"
            onClick={() => {
              if (nativeTouchSurface) inputRef.current?.blur();
              if (open) closePicker();
              else openPicker();
            }}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
          >
            <FolderOpen className="size-5" aria-hidden="true" />
          </button>
        </div>
        <div id={`${controlId}-browser`}>{picker}</div>
      </div>
    </div>
  );
}
