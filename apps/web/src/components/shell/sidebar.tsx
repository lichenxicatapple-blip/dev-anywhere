// 桌面端侧栏：固定 280px 宽，md 断点及以上可见（由 AppShell 传入 hidden md:flex 控制）
// Breadcrumb 语义分层：
//   顶部 proxy chip card（scope 选择器，视觉上独立）
//   中部 session list（工作对象，行式列表，edge-to-edge 选中条贴左边）
//   底部 + 新建会话 card（行动号召）
import { useSessionStore } from "@/stores/session-store";
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { ProxySwitcher } from "@/components/proxy/proxy-switcher";
import { SessionList, CreateSessionButton } from "@/components/session/session-list";
import { cn } from "@/lib/utils";

interface SidebarProps {
  className?: string;
}

export function Sidebar({ className }: SidebarProps) {
  const { collapsed } = useSidebarCollapsed();
  const sessionCount = useSessionStore((s) => s.sessions.length);

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
      {/* Proxy scope chip —— 带边框的 card，视觉上与下方 session list 拉开层级 */}
      <div className="p-2" data-slot="sidebar-proxy-switcher">
        <ProxySwitcher layout="dropdown" />
      </div>

      {/* Session list section —— section label 用 text-sm semibold foreground，与空态文案拉开层级 */}
      <div className="flex flex-col flex-1 overflow-hidden" data-slot="sidebar-session-list">
        <div className="px-4 pt-3 pb-2 text-sm font-semibold text-foreground">
          会话{sessionCount > 0 ? ` · ${sessionCount}` : ""}
        </div>
        <div className="flex-1 overflow-auto">
          <SessionList layout="sidebar" />
        </div>
      </div>

      {/* 底部行动区: 仅 + 新建会话 card (Settings 齿轮 D-53 已迁移至 AppShell 顶栏) */}
      <div className="p-2" data-slot="sidebar-new-session">
        <CreateSessionButton />
      </div>
    </nav>
  );
}
