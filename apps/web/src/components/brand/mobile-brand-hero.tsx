import type { ReactNode } from "react";
import { Typewriter } from "./typewriter";
import { BRAND_TEXTS } from "./constants";

interface MobileBrandHeroProps {
  subtitle: string;
  action?: ReactNode;
}

export function MobileBrandHero({ subtitle, action }: MobileBrandHeroProps) {
  return (
    <section
      className="dev-mobile-brand-hero border-b border-border/80 px-4 pb-5 pt-[calc(env(safe-area-inset-top)+1.25rem)] md:hidden"
      data-slot="mobile-brand-hero"
      aria-label="DEV Anywhere"
    >
      <div className="min-w-0 space-y-3 pr-14">
        <Typewriter
          texts={BRAND_TEXTS}
          className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-2xl font-bold tracking-normal"
        />
        <p className="max-w-[34rem] text-sm leading-5 text-muted-foreground">{subtitle}</p>
        {action ? <div className="flex max-w-full min-w-0 pt-1">{action}</div> : null}
      </div>
    </section>
  );
}
