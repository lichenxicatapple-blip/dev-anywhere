// /sessions 路由的双视图：
// - Mobile (< md)：SessionList layout="page" 作为全屏列表 + 底部 CTA
// - Desktop (≥ md)：sidebar 已承载 SessionList，主区展示上下文相关的空态
//   - 未选 proxy: no-proxy-selected
//   - 选了 proxy 但无 session: no-session-yet (区别于 no-session)
//   - 有 session 但未打开: no-session (提示左侧列表选择)
import { SessionList } from "@/components/session/session-list";
import { EmptyState } from "@/components/shell/empty-state";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";

export function SessionListPage() {
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);
  const sessionCount = useSessionStore((s) => s.sessions.length);

  let variant: "no-proxy-selected" | "no-session-yet" | "no-session";
  if (!hasProxy) variant = "no-proxy-selected";
  else if (sessionCount === 0) variant = "no-session-yet";
  else variant = "no-session";

  return (
    <>
      <div className="md:hidden h-full">
        <SessionList layout="page" />
      </div>
      <div className="hidden md:block h-full">
        <EmptyState variant={variant} />
      </div>
    </>
  );
}
