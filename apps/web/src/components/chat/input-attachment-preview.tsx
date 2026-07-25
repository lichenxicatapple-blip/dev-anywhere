import { useEffect, useState } from "react";
import { File, ImageIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ChatDraftAttachment } from "@/stores/chat-store";

interface InputAttachmentPreviewProps {
  attachments: ChatDraftAttachment[];
  onRemove: (attachmentId: string) => void;
}

export function InputAttachmentPreview({ attachments, onRemove }: InputAttachmentPreviewProps) {
  if (attachments.length === 0) return null;

  return (
    <div
      className="flex w-full gap-2 overflow-x-auto px-2.5 pt-2.5 pb-1"
      data-slot="input-attachments"
      aria-label="已上传附件"
    >
      {attachments.map((attachment) =>
        attachment.kind === "image" ? (
          <ImageAttachment key={attachment.id} attachment={attachment} onRemove={onRemove} />
        ) : (
          <FileAttachment key={attachment.id} attachment={attachment} onRemove={onRemove} />
        ),
      )}
    </div>
  );
}

function ImageAttachment({
  attachment,
  onRemove,
}: {
  attachment: ChatDraftAttachment;
  onRemove: (attachmentId: string) => void;
}) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (typeof URL.createObjectURL !== "function") return;
    const nextUrl = URL.createObjectURL(attachment.file);
    setPreviewUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [attachment.file]);

  return (
    <div
      className="group relative size-20 shrink-0 overflow-hidden rounded-md border bg-muted"
      data-slot="input-image-attachment"
      title={attachment.file.name}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={attachment.file.name}
          className="size-full object-contain"
          data-slot="input-image-attachment-preview"
        />
      ) : (
        <div className="flex size-full items-center justify-center text-muted-foreground">
          <ImageIcon className="size-5" aria-hidden="true" />
        </div>
      )}
      <RemoveAttachmentButton attachment={attachment} onRemove={onRemove} />
    </div>
  );
}

function FileAttachment({
  attachment,
  onRemove,
}: {
  attachment: ChatDraftAttachment;
  onRemove: (attachmentId: string) => void;
}) {
  return (
    <div
      className="relative flex h-16 w-56 shrink-0 items-center gap-2.5 rounded-md border bg-muted/50 px-3 pr-9"
      data-slot="input-file-attachment"
      title={attachment.file.name}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-background text-muted-foreground">
        <File className="size-4" aria-hidden="true" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium" data-slot="input-attachment-name">
          {attachment.file.name}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {formatFileSize(attachment.file.size)}
        </div>
      </div>
      <RemoveAttachmentButton attachment={attachment} onRemove={onRemove} />
    </div>
  );
}

function RemoveAttachmentButton({
  attachment,
  onRemove,
}: {
  attachment: ChatDraftAttachment;
  onRemove: (attachmentId: string) => void;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      className="absolute right-1 top-1 size-7 border bg-background/90 shadow-xs hover:bg-background"
      aria-label={`移除附件 ${attachment.file.name}`}
      data-slot="input-attachment-remove"
      onClick={() => onRemove(attachment.id)}
    >
      <X className="size-3.5" aria-hidden="true" />
    </Button>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / (1024 * 102.4)) / 10} MB`;
}
