// Cmd+K / Ctrl+K 全局命令面板，订阅 app-store 与 session-store，分组展示会话 / Proxy / 动作
// 文案与分组锁定 10-UI-SPEC.md Copywriting Contract
import { useState, useCallback } from "react";
import { useNavigate } from "react-router";
import { useAppStore } from "@/stores/app-store";
import { useSessionStore } from "@/stores/session-store";
import { useKeyboardShortcut } from "@/hooks/use-keyboard-shortcut";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
  CommandEmpty,
} from "@/components/ui/command";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const proxies = useAppStore((s) => s.proxies);
  const sessions = useSessionStore((s) => s.sessions);

  const onOpenKey = useCallback(() => {
    setOpen((prev) => !prev);
  }, []);

  useKeyboardShortcut("k", onOpenKey, { meta: true, ctrl: true, preventDefault: true });

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="搜索会话、proxy 或命令…" />
      <CommandList>
        <CommandEmpty>没有匹配结果</CommandEmpty>

        {sessions.length > 0 && (
          <CommandGroup heading="会话">
            {sessions.map((s) => (
              <CommandItem
                key={s.sessionId}
                value={`session-${s.sessionId}-${s.name ?? ""}`}
                onSelect={() => {
                  navigate(`/chat/${s.sessionId}?mode=${s.mode}`);
                  setOpen(false);
                }}
              >
                {s.name ?? s.sessionId}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {proxies.length > 0 && (
          <CommandGroup heading="Proxy">
            {proxies.map((p) => (
              <CommandItem
                key={p.proxyId}
                value={`proxy-${p.proxyId}-${p.name ?? ""}`}
                onSelect={() => {
                  // Plan 10-02 会绑定 selectProxy，这里先导航回根路由占位
                  navigate("/");
                  setOpen(false);
                }}
              >
                {p.name ?? p.proxyId}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="动作">
          <CommandItem
            value="action-new-session"
            onSelect={() => {
              navigate("/sessions");
              setOpen(false);
            }}
          >
            新建会话
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
