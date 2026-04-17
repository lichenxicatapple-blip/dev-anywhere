import { createHashRouter } from "react-router";
import { AppShell } from "@/components/shell/app-shell";
import { ProxySelectPage } from "@/pages/proxy-select";
import { SessionListPage } from "@/pages/session-list";
import { ChatPage } from "@/pages/chat";
import { PtyTest } from "@/pages/pty-test";
import { TokenShowcase } from "@/pages/token-showcase";

// AppShell 承载三个业务路由的统一 chrome（header / sidebar / Toaster / CommandPalette）
// /pty-test 与 /tokens 是调试/校验页，不进入 shell，避免被 master-detail 布局干扰（D-41）
export const router = createHashRouter([
  {
    path: "/",
    element: <AppShell />,
    children: [
      { index: true, element: <ProxySelectPage /> },
      { path: "sessions", element: <SessionListPage /> },
      { path: "chat/:id", element: <ChatPage /> },
    ],
  },
  { path: "/pty-test", element: <PtyTest /> },
  { path: "/tokens", element: <TokenShowcase /> },
]);
