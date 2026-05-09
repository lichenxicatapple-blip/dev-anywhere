import { cn } from "@/lib/utils";

interface BrandMarkProps {
  className?: string;
  slot?: string;
}

export function BrandMark({ className, slot = "brand-mark" }: BrandMarkProps) {
  return (
    <span
      className={cn("min-w-0 truncate font-mono font-semibold tracking-normal", className)}
      data-slot={slot}
    >
      <span className="text-primary">DEV</span>
      <span className="text-foreground/90"> Anywhere</span>
    </span>
  );
}
