// 统一空状态容器, 桌面主 panel 的"入场类"空态走 BrandHero, 这里只保留边缘/下钻场景:
//   no-proxy     — 移动端 ProxySwitcher layout=page 列表空
//   no-session   — ChatPage 未拿到 :id 的 fallback (异常导航)
//   no-messages  — 会话内消息为空
import type { ReactNode } from "react";

type Variant = "no-proxy" | "no-session" | "no-messages";

interface EmptyStateProps {
  variant: Variant;
  action?: ReactNode;
}

const COPY: Record<Variant, { heading: string; body: string }> = {
  "no-proxy": {
    heading: "还没有连接本机",
    body: "在电脑上启动 dev-anywhere，本页会显示可连接的电脑。",
  },
  "no-session": {
    heading: "没有选中的会话",
    body: "",
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
      <div className="flex h-full w-full items-center justify-center animate-in fade-in-0 duration-200 motion-reduce:animate-none">
        <p className="text-sm text-muted-foreground">{heading}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-6 px-6 text-center animate-in fade-in-0 duration-200 motion-reduce:animate-none">
      <h2 className="text-2xl font-semibold">{heading}</h2>
      {body && <p className="max-w-md text-sm text-muted-foreground">{body}</p>}
      {action && <div>{action}</div>}
    </div>
  );
}
