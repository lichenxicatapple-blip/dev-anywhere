// 统一空状态容器，variant 决定标题/正文/可选 CTA 的组合
// 文案源自 10-UI-SPEC.md Copywriting Contract，不允许本组件自由发挥
import type { ReactNode } from "react";

type Variant = "no-proxy" | "no-session" | "no-messages";

interface EmptyStateProps {
  variant: Variant;
  action?: ReactNode;
}

const COPY: Record<Variant, { heading: string; body: string }> = {
  "no-proxy": {
    heading: "尚未连接 Proxy",
    body: "在本地运行 cc-anywhere 后，它会出现在这里。查看安装指引 →",
  },
  "no-session": {
    heading: "选择一个会话",
    body: "从左侧列表选择，或点击「新建会话」开始。",
  },
  "no-messages": {
    heading: "开始对话",
    body: "",
  },
};

export function EmptyState({ variant, action }: EmptyStateProps) {
  const { heading, body } = COPY[variant];
  const isMinimal = variant === "no-messages";

  if (isMinimal) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <p className="text-sm text-muted-foreground">{heading}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 px-6 text-center">
      <h2 className="text-2xl font-semibold">{heading}</h2>
      {body && <p className="max-w-md text-sm text-muted-foreground">{body}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}
