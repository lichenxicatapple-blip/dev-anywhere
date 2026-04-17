// /sessions 路由的双视图：
// - Mobile (< md)：SessionList layout="page" 作为全屏列表 + 底部 CTA
// - Desktop (≥ md)：sidebar 已承载 SessionList，主区改为"还没选会话"空状态
//   （避免与 sidebar 底部的 "+ 新建会话" 按钮重复渲染）
import { SessionList } from "@/components/session/session-list";
import { EmptyState } from "@/components/shell/empty-state";

export function SessionListPage() {
  return (
    <>
      <div className="md:hidden h-full">
        <SessionList layout="page" />
      </div>
      <div className="hidden md:block h-full">
        <EmptyState variant="no-session" />
      </div>
    </>
  );
}
