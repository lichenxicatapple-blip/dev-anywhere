// 桌面端侧栏：固定 280px 宽，md 断点及以上可见（由 AppShell 传入 hidden md:flex 控制）
// 顶部 ProxySwitcher / 中部 SessionList / 底部 CreateSessionButton —— 三个模块路径是下游 Plan 10-02、10-03 的契约
// ⚠ 冻结：sidebar.tsx 在本 plan 之后不再修改，Plans 10-02/10-03 仅替换被 import 的模块 body
import { Separator } from "@/components/ui/separator";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { ProxySwitcher } from "@/components/proxy/proxy-switcher";
import { SessionList, CreateSessionButton } from "@/components/session/session-list";
import { cn } from "@/lib/utils";

interface SidebarProps {
  className?: string;
}

export function Sidebar({ className }: SidebarProps) {
  const { collapsed } = useSidebarCollapsed();

  if (collapsed) {
    return null;
  }

  return (
    <nav
      className={cn(
        "flex-col w-[280px] shrink-0 bg-card border-r border-border overflow-hidden",
        className,
      )}
      aria-label="Sidebar navigation"
    >
      <div className="px-4 py-3" data-slot="sidebar-proxy-switcher">
        <ProxySwitcher layout="dropdown" />
      </div>
      <Separator />
      <div className="flex-1 overflow-auto" data-slot="sidebar-session-list">
        <SessionList layout="sidebar" />
      </div>
      <Separator />
      <div className="p-3" data-slot="sidebar-new-session">
        <CreateSessionButton />
      </div>
    </nav>
  );
}
