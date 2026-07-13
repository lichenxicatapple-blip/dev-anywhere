import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SessionRenameDialogProps {
  open: boolean;
  sessionId: string | null;
  initialName?: string;
  onOpenChange: (open: boolean) => void;
  onRename: (sessionId: string, name: string) => Promise<void>;
}

export function SessionRenameDialog({
  open,
  sessionId,
  initialName,
  onOpenChange,
  onRename,
}: SessionRenameDialogProps) {
  const defaultValue = useMemo(() => initialName?.trim() ?? "", [initialName]);
  const [value, setValue] = useState(defaultValue);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValue(defaultValue);
    setError(null);
    setSubmitting(false);
  }, [defaultValue, open]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError("会话标题不能为空");
      return;
    }
    if (!sessionId) return;
    setSubmitting(true);
    try {
      await onRename(sessionId, trimmed);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-slot="session-rename-dialog">
        <form className="grid gap-4" onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>自定义名称会显示在会话列表和顶部标题中。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <label htmlFor="session-rename-title" className="text-sm font-medium">
              会话标题
            </label>
            <input
              id="session-rename-title"
              value={value}
              autoFocus
              maxLength={100}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "session-rename-error" : undefined}
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
              <p id="session-rename-error" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
