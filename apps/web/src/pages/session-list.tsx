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
  if (proxies.length === 0) subtitle = "在电脑上启动 dev-anywhere，本页会显示可连接的电脑。";
  else if (!hasProxy) subtitle = "选择要连接的电脑。";
  else if (sessionCount === 0) subtitle = "从本地终端接入，或新建一个会话。";
  else subtitle = "选择一个会话继续，或新建。";

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
