// 移动端 ProxySelect 页, 使用 ProxySwitcher layout="page"
// 桌面端主入口是 sidebar 内的 dropdown, 但此页在深链 `/` 时仍作为 fallback 渲染
// 页面本身不含业务逻辑, 仅作薄壳转发给 ProxySwitcher
import { ProxySwitcher } from "@/components/proxy/proxy-switcher";

export function ProxySelectPage() {
  return <ProxySwitcher layout="page" />;
}
