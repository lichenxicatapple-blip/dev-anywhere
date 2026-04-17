"use client"

// shadcn CLI 默认模板依赖 next-themes 且 import 自身导致循环引用
// Phase 10 锁定深色主题（D-04），由 Plan 10-01a Task 2 重写为 UI-SPEC 契约版本
// 这里提供最小可通过 typecheck 的 Toaster 直通包装
import { Toaster as SonnerToaster } from "sonner"

export function Toaster(props: React.ComponentProps<typeof SonnerToaster>) {
  return <SonnerToaster {...props} />
}
