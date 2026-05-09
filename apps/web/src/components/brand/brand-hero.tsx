// 桌面主 panel 的品牌欢迎区: Typewriter + 上下文副标题 (+ 可选 action)
// 横贯所有非 chat 空态, 让 funnel 过程中 brand 常驻, 只切 subtitle
import type { ReactNode } from "react";
import { Typewriter } from "./typewriter";
import { BRAND_TEXTS } from "./constants";

interface Props {
  subtitle: string;
  action?: ReactNode;
}

export function BrandHero({ subtitle, action }: Props) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 px-6 text-center">
      <Typewriter texts={BRAND_TEXTS} className="text-2xl md:text-3xl font-bold" />
      <p className="max-w-md text-sm text-muted-foreground">{subtitle}</p>
      {action && <div>{action}</div>}
    </div>
  );
}
