// 统一空状态容器，variant 决定标题/正文/可选 CTA 的组合
// 文案源自 10-UI-SPEC.md Copywriting Contract，不允许本组件自由发挥
import type { ReactNode } from "react";

type Variant =
  | "no-proxy"
  | "no-proxy-selected"
  | "no-session-yet"
  | "no-session"
  | "no-messages";

interface EmptyStateProps {
  variant: Variant;
  action?: ReactNode;
}

const COPY: Record<Variant, { heading: string; body: string }> = {
  "no-proxy": {
    heading: "尚未连接 Proxy",
    body: "在本地运行 cc-anywhere 后，它会出现在这里。查看安装指引 →",
  },
  "no-proxy-selected": {
    heading: "请先选择 Proxy",
    body: "从左上角选择一个本地代理后，再创建或查看会话。",
  },
  "no-session-yet": {
    heading: "暂无会话",
    body: "本地启动 cc-anywhere，或远程新建会话。",
  },
  "no-session": {
    heading: "选择一个会话",
    body: "从左侧列表点击一项进入对话。",
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
