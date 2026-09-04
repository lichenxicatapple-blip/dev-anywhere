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

function isAbsolutePosixPath(path: string): boolean {
  return path.startsWith("/");
}

function parentDirectory(path: string): string {
  const normalized = path.replace(/\/+$/, "") || "/";
  if (normalized === "/") return "/";
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : `${normalized.slice(0, lastSlash)}/`;
}

function pickerStart(
  value: string,
  homePath: string,
  selectionKind: RemotePathSelectionKind,
): string {
  if (!isAbsolutePosixPath(value)) return homePath;
  return selectionKind === "file" ? parentDirectory(value) : value;
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
  const [desktopDraft, setDesktopDraft] = useState(value);
  const rootRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<PickerHandle>(null);

  useEffect(() => {
    if (open || desktopDraft === value) return;
    setDesktopDraft(value);
  }, [desktopDraft, open, value]);

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
      setDesktopDraft(value);
    }

    // Let the clicked control finish its own action before an inline picker changes layout.
    // Closing on pointerdown could move mobile buttons away before their click was delivered.
    document.addEventListener("click", closeOnOutsideClick);
    return () => document.removeEventListener("click", closeOnOutsideClick);
  }, [open, value]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setDesktopDraft(value);
  }, [disabled, value]);

  const canSelectCurrentDirectory = selectionKind !== "file";

  function openPicker(): void {
    if (disabled) return;
    const start = pickerStart(value, homePath, selectionKind);
    setBrowsePath(start);
    setDesktopDraft(value);
    setOpen(true);
  }

  function closePicker(): void {
    setOpen(false);
    setDesktopDraft(value);
  }

  function commitAbsolutePath(path: string): void {
    if (!isAbsolutePosixPath(path)) return;
    setBrowsePath(path);
    setDesktopDraft(path);
    onValueChange(path);
    setOpen(false);
  }

  function navigate(path: string): void {
    if (!isAbsolutePosixPath(path)) return;
    setBrowsePath(path);
  }

  function handleDesktopKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
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
        {nativeTouchSurface ? (
          <>
            <button
              id={controlId}
              type="button"
              aria-labelledby={labelId}
              aria-describedby={ariaDescribedBy}
              aria-invalid={ariaInvalid}
              aria-expanded={open}
              aria-controls={`${controlId}-browser`}
              disabled={disabled}
              data-slot={dataSlot}
              data-path-control="button"
              onClick={() => {
                if (open) closePicker();
                else openPicker();
              }}
              className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-input px-3 text-left text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            >
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-mono",
                  value ? "text-foreground" : "text-muted-foreground",
                )}
                title={value || undefined}
              >
                {value || placeholder}
              </span>
            </button>
            {name ? <input type="hidden" name={name} value={value} required={required} /> : null}
            <div id={`${controlId}-browser`}>{picker}</div>
          </>
        ) : (
          <>
            <input
              id={controlId}
              type="text"
              aria-labelledby={labelId}
              aria-describedby={ariaDescribedBy}
              aria-invalid={ariaInvalid}
              name={name}
              required={required}
              autoFocus={autoFocus}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={disabled}
              value={desktopDraft}
              data-slot={dataSlot}
              data-path-control="input"
              onFocus={openPicker}
              onChange={(event) => {
                const path = event.target.value;
                setDesktopDraft(path);
                setBrowsePath(isAbsolutePosixPath(path) ? path : homePath);
                onValueChange(path);
                setOpen(true);
              }}
              onKeyDown={handleDesktopKeyDown}
              placeholder={placeholder}
              className="min-h-11 min-w-0 w-full rounded-md border border-border bg-input px-3 font-mono text-base outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 md:h-9 md:min-h-0 md:text-sm"
            />
            {picker}
          </>
        )}
      </div>
    </div>
  );
}
