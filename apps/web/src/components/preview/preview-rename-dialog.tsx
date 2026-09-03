import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface PreviewRenameTarget {
  readonly targetKey: string;
  readonly name: string;
}

interface PreviewRenameDialogProps {
  target: PreviewRenameTarget | null;
  onOpenChange: (open: boolean) => void;
  onRename: (name: string) => Promise<void>;
}

export function PreviewRenameDialog({ target, onOpenChange, onRename }: PreviewRenameDialogProps) {
  return (
    <PreviewRenameDialogInstance
      key={target?.targetKey ?? "closed"}
      target={target}
      onOpenChange={onOpenChange}
      onRename={onRename}
    />
  );
}

function PreviewRenameDialogInstance({ target, onOpenChange, onRename }: PreviewRenameDialogProps) {
  const [value, setValue] = useState(() => target?.name.trim() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const activeTargetKeyRef = useRef<string | null>(target?.targetKey ?? null);

  useLayoutEffect(() => {
    return () => {
      activeTargetKeyRef.current = null;
    };
  }, []);

  function handleOpenChange(open: boolean): void {
    if (!open && submitting) return;
    onOpenChange(open);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError("名称不能为空");
      return;
    }
    if (!target || submitting) return;

    const submittedTargetKey = target.targetKey;
    setSubmitting(true);
    try {
      await onRename(trimmed);
      if (activeTargetKeyRef.current !== submittedTargetKey) return;
      onOpenChange(false);
    } catch (renameError) {
      if (activeTargetKeyRef.current !== submittedTargetKey) return;
      setError(renameError instanceof Error ? renameError.message : String(renameError));
    } finally {
      if (activeTargetKeyRef.current === submittedTargetKey) setSubmitting(false);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!submitting}
        className="sm:max-w-md"
        data-slot="preview-rename-dialog"
      >
        <form className="grid gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>重命名预览</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <label htmlFor="preview-rename-name" className="text-sm font-medium">
              预览名称
            </label>
            <input
              id="preview-rename-name"
              value={value}
              autoFocus
              maxLength={256}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "preview-rename-error" : undefined}
              data-slot="preview-rename-input"
              className={cn(
                "h-10 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[border-color,box-shadow]",
                "placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/75",
                "disabled:cursor-not-allowed disabled:opacity-50",
                error && "border-destructive focus-visible:ring-destructive/20",
              )}
              disabled={submitting}
              onChange={(event) => {
                setValue(event.target.value);
                if (error) setError(null);
              }}
            />
            {error ? (
              <p id="preview-rename-error" className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => handleOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={submitting} data-slot="preview-rename-submit">
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
