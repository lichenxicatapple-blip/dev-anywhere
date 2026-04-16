import { createHashRouter } from "react-router";
import { ProxySelectPage } from "@/pages/proxy-select";
import { SessionListPage } from "@/pages/session-list";
import { ChatPage } from "@/pages/chat";
import { PtyTest } from "@/pages/pty-test";
import { TokenShowcase } from "@/pages/token-showcase";

export const router = createHashRouter([
  { path: "/", element: <ProxySelectPage /> },
  { path: "/sessions", element: <SessionListPage /> },
  { path: "/chat/:id", element: <ChatPage /> },
  { path: "/pty-test", element: <PtyTest /> },
  { path: "/tokens", element: <TokenShowcase /> },
]);
