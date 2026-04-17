// 根路由 `/` 的双视图：
// - Mobile (< md)：ProxySwitcher layout="page" 作为首次进入时选 proxy 的全屏入口
// - Desktop (≥ md)：sidebar 已承载 ProxySwitcher dropdown，主区改为"还没选会话"空状态
//   （UI-SPEC §Responsive: master-detail activation — ProxySelect becomes sidebar-top dropdown, not a page）
import { ProxySwitcher } from "@/components/proxy/proxy-switcher";
import { EmptyState } from "@/components/shell/empty-state";

export function ProxySelectPage() {
  return (
    <>
      <div className="md:hidden h-full">
        <ProxySwitcher layout="page" />
      </div>
      <div className="hidden md:block h-full">
        <EmptyState variant="no-session" />
      </div>
    </>
  );
}
