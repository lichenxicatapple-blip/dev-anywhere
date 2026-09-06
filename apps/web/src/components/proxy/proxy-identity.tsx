import { cn } from "@/lib/utils";

export function ProxyIdentity({
  name,
  osName,
  className,
  nameClassName,
}: {
  name: string;
  osName?: string;
  className?: string;
  nameClassName?: string;
}) {
  return (
    <span className={cn("min-w-0 flex-1", className)}>
      <span
        data-slot="proxy-name"
        className={cn("block truncate text-sm font-normal leading-5", nameClassName)}
      >
        {name}
      </span>
      {osName && (
        <span
          data-slot="proxy-os"
          className="block truncate text-xs font-normal leading-4 text-muted-foreground"
        >
          {osName}
        </span>
      )}
    </span>
  );
}
