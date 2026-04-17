// ProxySwitcher 占位实现：Plan 10-01b 先落模块路径契约，Plan 10-02 整体替换 body
// 在 10-01b 创建而非 10-02 的原因：Sidebar 在 W2 就要直接 import 该模块，
// W3 并行执行的 10-02 才能只改 body 而不触 sidebar.tsx，避免写冲突
interface ProxySwitcherProps {
  layout: "page" | "dropdown";
}

export function ProxySwitcher({ layout }: ProxySwitcherProps) {
  return (
    <div
      data-slot="proxy-switcher-stub"
      data-layout={layout}
      className="text-xs text-muted-foreground"
    >
      ProxySwitcher ({layout}) — Plan 10-02 will implement
    </div>
  );
}
