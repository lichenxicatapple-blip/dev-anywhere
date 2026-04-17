// SessionList / CreateSessionButton 占位实现：Plan 10-01b 先落模块路径契约，Plan 10-03 整体替换 body
// 同 proxy-switcher 的动机：Sidebar 在 W2 就能 import，W3 并行的 10-03 只改 body
interface SessionListProps {
  layout: "page" | "sidebar";
}

export function SessionList({ layout }: SessionListProps) {
  return (
    <div
      data-slot="session-list-stub"
      data-layout={layout}
      className="p-4 text-xs text-muted-foreground"
    >
      SessionList ({layout}) — Plan 10-03 will implement
    </div>
  );
}

export function CreateSessionButton() {
  return (
    <div
      data-slot="create-session-button-stub"
      className="text-xs text-muted-foreground"
    >
      + 新建会话 — Plan 10-03 will implement
    </div>
  );
}
