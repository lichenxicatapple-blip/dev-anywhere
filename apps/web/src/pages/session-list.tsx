// /sessions 路由的双视图：
// - Mobile (< md)：SessionList layout="page" 作为全屏列表 + 底部 CTA
// - Desktop (≥ md)：sidebar 已承载 SessionList，主区走 BrandHero + 上下文 subtitle
import { SessionList } from "@/components/session/session-list";
import { BrandHero } from "@/components/brand/brand-hero";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";

export function SessionListPage() {
  const proxies = useAppStore((s) => s.proxies);
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);
  const sessionCount = useSessionStore((s) => s.sessions.length);

  let subtitle: string;
  if (proxies.length === 0) subtitle = "在开发机上启动 DEV Anywhere，本页会显示可连接的开发机。";
  else if (!hasProxy) subtitle = "选择要连接的开发机。";
  else if (sessionCount === 0) subtitle = "还没有会话。可以从本地终端接入，也可以新建会话。";
  else subtitle = "从左侧打开会话，或新建会话开始新的任务。";

  return (
    <>
      <div className="md:hidden h-full">
        <SessionList layout="page" />
      </div>
      <div className="hidden md:block h-full">
        <BrandHero subtitle={subtitle} />
      </div>
    </>
  );
}
