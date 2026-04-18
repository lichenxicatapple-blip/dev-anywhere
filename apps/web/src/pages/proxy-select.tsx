// 根路由 `/` 的双视图：
// - Mobile (< md)：ProxySwitcher layout="page" 作为首次进入时选 proxy 的全屏入口
// - Desktop (≥ md)：sidebar 已承载 ProxySwitcher dropdown，主区展示上下文相关主视觉
//   未选 proxy → Typewriter brand hero + 小字提示；已选无 session → "开始你的第一个会话"；有 session → "打开一个会话"
import { ProxySwitcher } from "@/components/proxy/proxy-switcher";
import { EmptyState } from "@/components/shell/empty-state";
import { Typewriter } from "@/components/brand/typewriter";
import { useSessionStore } from "@/stores/session-store";
import { useAppStore } from "@/stores/app-store";

const BRAND_TEXTS = ["CC Anywhere", "/unlimited @anytime"];

export function ProxySelectPage() {
  const hasProxy = useAppStore((s) => !!s.selectedProxyId);
  const sessionCount = useSessionStore((s) => s.sessions.length);

  return (
    <>
      <div className="md:hidden h-full">
        <ProxySwitcher layout="page" />
      </div>
      <div className="hidden md:block h-full">
        {!hasProxy ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-6 px-6 text-center">
            <Typewriter texts={BRAND_TEXTS} />
            <p className="text-sm text-muted-foreground">
              从左上角选择一个本地 Proxy 开始。
            </p>
          </div>
        ) : (
          <EmptyState variant={sessionCount === 0 ? "no-session-yet" : "no-session"} />
        )}
      </div>
    </>
  );
}
