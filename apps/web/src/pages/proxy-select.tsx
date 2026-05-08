// 根路由 `/` 的双视图：
// - Mobile (< md)：ProxySwitcher layout="page" 作为首次进入时选 proxy 的全屏入口
// - Desktop (≥ md)：sidebar 已承载 ProxySwitcher dropdown，主区走 BrandHero + 上下文 subtitle
import { ProxySwitcher } from "@/components/proxy/proxy-switcher";
import { BrandHero } from "@/components/brand/brand-hero";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";

export function ProxySelectPage() {
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
        <ProxySwitcher layout="page" />
      </div>
      <div className="hidden md:block h-full">
        <BrandHero subtitle={subtitle} />
      </div>
    </>
  );
}
