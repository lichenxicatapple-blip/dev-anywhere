// 历史会话区: 读 useSessionStore.historySessions, 按 projectDir 分组, 双层折叠
// 外层: section 整体默认折叠, 点 "历史会话" header 整体展开; 活跃会话优先占主视野
// 内层: 展开后每个 projectDir group 默认再折叠, 点 chevron 才看到 HistoryRow
// 点击行 → session_create + resumeSessionId; 同一时刻只允许 1 个 resume 在飞。
// 刷新按钮: 通过 RelayClient 请求历史会话, proxy 会重新扫 ~/.claude/projects/
// group 顺序沿用 historySessions 的 updatedAt 降序 (proxy 保证), 最近活跃的 project 在最上
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Check, ChevronRight, MessageSquare, RefreshCw, TerminalSquare } from "lucide-react";
import type { HistorySession, SessionInfo } from "@dev-anywhere/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSessionStore } from "@/stores/session-store";
import { relayClientRef } from "@/hooks/use-relay-setup";
import { toast } from "@/components/toast";
import { cn } from "@/lib/utils";
import { formatSessionName } from "@/lib/format-session-name";
import {
  compareProvider,
  historySessionProvider,
  providerLabel,
  type SessionProvider,
} from "@/lib/session-provider";
import { HistoryRow } from "./history-row";

interface HistoryListProps {
  now?: number;
}

type RestoreMode = "pty" | "json";
type RestorePermissionMode = "default" | "auto" | "bypassPermissions";

export function HistoryList({ now }: HistoryListProps) {
  const historySessions = useSessionStore((s) => s.historySessions);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<HistorySession | null>(null);
  const [restoreMode, setRestoreMode] = useState<RestoreMode>("json");
  const [restorePermissionMode, setRestorePermissionMode] =
    useState<RestorePermissionMode>("default");
  // 整个历史会话区默认折叠, 让活跃会话占据主视野; 点 header 整体展开后再点 group chevron 看行
  const [sectionExpanded, setSectionExpanded] = useState(false);
  const [collapsedProviders, setCollapsedProviders] = useState<Set<SessionProvider>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const navigate = useNavigate();

  const providerGroups = useMemo(() => {
    const providerMap = new Map<
      SessionProvider,
      Map<string, { dir: string; sessions: HistorySession[] }>
    >();
    for (const h of historySessions) {
      const provider = historySessionProvider(h);
      let projectMap = providerMap.get(provider);
      if (!projectMap) {
        projectMap = new Map<string, { dir: string; sessions: HistorySession[] }>();
        providerMap.set(provider, projectMap);
      }
      const groupDir = normalizeHistoryProjectDir(h.projectDir);
      const bucket = projectMap.get(groupDir);
      if (bucket) bucket.sessions.push(h);
      else projectMap.set(groupDir, { dir: groupDir, sessions: [h] });
    }
    return Array.from(providerMap.entries())
      .sort(([a], [b]) => compareProvider(a, b))
      .map(([provider, projectMap]) => ({
        provider,
        sessions: Array.from(projectMap.values()).flatMap((group) => group.sessions),
        projects: Array.from(projectMap.values()).map((group) => ({
          dir: group.dir,
          shortDir: formatSessionName(group.dir),
          sessions: group.sessions,
        })),
      }));
  }, [historySessions]);

  function openRestoreDialog(h: HistorySession) {
    setRestoreTarget(h);
    setRestoreMode(defaultRestoreMode(h));
    setRestorePermissionMode("default");
  }

  async function handleResume(
    h: HistorySession,
    mode: RestoreMode,
    permissionMode?: RestorePermissionMode,
  ) {
    if (resumingId) return;
    const relay = relayClientRef;
    if (!relay) {
      toast.error("请先连接开发机");
      return;
    }
    setResumingId(h.id);
    const provider = historySessionProvider(h);
    try {
      const ctrl = await relay.createSession({
        cwd: h.projectDir,
        mode,
        provider,
        resumeSessionId: h.id,
        ...(mode === "pty" && permissionMode ? { permissionMode } : {}),
      });
      if (ctrl.error || !ctrl.sessionId) {
        toast.error(`恢复失败：${ctrl.error ?? "未知错误"}`);
        return;
      }
      const newSession: SessionInfo = {
        sessionId: ctrl.sessionId,
        state: "idle",
        mode: ctrl.mode ?? mode,
        provider: ctrl.provider ?? "claude",
      };
      useSessionStore.getState().addSession(newSession);
      navigate(`/chat/${ctrl.sessionId}?mode=${ctrl.mode ?? mode}`);
      setRestoreTarget(null);
    } catch (err) {
      toast.error(`恢复失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setResumingId(null);
    }
  }

  function handleRefresh() {
    const relay = relayClientRef;
    if (!relay) return;
    void relay
      .requestSessionHistory()
      .then((sessions) => useSessionStore.getState().setHistorySessions(sessions))
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err));
      });
  }

  function toggleGroup(provider: SessionProvider, dir: string) {
    const key = historyProjectGroupKey(provider, dir);
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleProvider(provider: SessionProvider) {
    setCollapsedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  }

  const hasHistory = historySessions.length > 0;
  const restoreModes = restoreTarget ? availableRestoreModes(restoreTarget) : [];

  return (
    <div data-slot="history-list" className="flex flex-col">
      {/* section header 整行做 toggle 触发器; 刷新按钮放里边要 stopPropagation, 否则点刷新也会 toggle */}
      {/* 历史为空时 header 的 toggle/chevron 都禁用, 只保留刷新 (可能扫完 claude 目录后就出来了) */}
      <button
        type="button"
        onClick={() => hasHistory && setSectionExpanded((v) => !v)}
        disabled={!hasHistory}
        aria-expanded={hasHistory ? sectionExpanded : undefined}
        data-slot="history-section-header"
        data-expanded={sectionExpanded}
        className={cn(
          "w-full flex items-center gap-1.5 px-4 py-2 min-h-[36px]",
          "text-left transition-colors outline-none",
          "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:hover:bg-transparent disabled:cursor-default",
        )}
      >
        <h3 className="text-sm font-semibold text-foreground">
          全部会话
          {hasHistory ? (
            <span className="ml-1 text-muted-foreground/70 font-normal">
              · {historySessions.length}
            </span>
          ) : null}
        </h3>
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            handleRefresh();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              handleRefresh();
            }
          }}
          aria-label="刷新全部会话"
          data-slot="history-refresh"
          className={cn(
            "ml-auto size-6 rounded-md flex items-center justify-center",
            "text-muted-foreground hover:text-foreground hover:bg-accent",
            "transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
        </span>
        {hasHistory ? (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/80 transition-transform",
              sectionExpanded && "rotate-90",
            )}
            aria-hidden="true"
          />
        ) : null}
      </button>
      {!hasHistory && (
        <div className="px-4 py-3 text-sm text-muted-foreground/70" data-slot="history-empty">
          暂无会话记录
        </div>
      )}
      {hasHistory && sectionExpanded && (
        <ul role="list" className="flex flex-col">
          {providerGroups.map((providerGroup) => {
            const providerCollapsed = collapsedProviders.has(providerGroup.provider);
            return (
              <li key={providerGroup.provider}>
                <button
                  type="button"
                  onClick={() => toggleProvider(providerGroup.provider)}
                  aria-expanded={!providerCollapsed}
                  data-slot="history-provider-header"
                  data-expanded={!providerCollapsed}
                  className={cn(
                    "w-full flex items-center gap-2 px-4 pt-2 pb-1 min-h-[32px]",
                    "text-xs text-muted-foreground text-left transition-colors outline-none",
                    "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <span className="font-mono">{providerLabel(providerGroup.provider)}</span>
                  <span className="h-px flex-1 bg-border/70" aria-hidden="true" />
                  <span className="tabular-nums">{providerGroup.sessions.length}</span>
                  <ChevronRight
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground/80 transition-transform",
                      !providerCollapsed && "rotate-90",
                    )}
                    aria-hidden="true"
                  />
                </button>
                {!providerCollapsed && (
                  <ul role="list" className="flex flex-col">
                    {providerGroup.projects.map((g) => {
                      const groupKey = historyProjectGroupKey(providerGroup.provider, g.dir);
                      const expanded = expandedGroups.has(groupKey);
                      return (
                        <li key={groupKey}>
                          <button
                            type="button"
                            onClick={() => toggleGroup(providerGroup.provider, g.dir)}
                            aria-expanded={expanded}
                            data-slot="history-group-header"
                            data-expanded={expanded}
                            className={cn(
                              "w-full flex items-center gap-1.5 pl-6 pr-4 py-2 min-h-[36px]",
                              "text-left transition-colors outline-none",
                              "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                            )}
                          >
                            <span
                              className="text-sm font-mono truncate flex-1 min-w-0"
                              title={g.dir}
                            >
                              {g.shortDir}
                            </span>
                            <span className="text-xs text-muted-foreground/80 tabular-nums shrink-0">
                              {g.sessions.length}
                            </span>
                            <ChevronRight
                              className={cn(
                                "size-3.5 shrink-0 text-muted-foreground/80 transition-transform",
                                expanded && "rotate-90",
                              )}
                              aria-hidden="true"
                            />
                          </button>
                          {expanded && (
                            <ul role="list" className="flex flex-col">
                              {g.sessions.map((h) => (
                                <HistoryRow
                                  key={h.id}
                                  session={h}
                                  now={now}
                                  disabled={resumingId !== null}
                                  loading={resumingId === h.id}
                                  onClick={() => openRestoreDialog(h)}
                                  modeTag={h.preferredMode}
                                />
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <HistoryRestoreDialog
        session={restoreTarget}
        open={restoreTarget !== null}
        modes={restoreModes}
        mode={restoreMode}
        permissionMode={restorePermissionMode}
        submitting={resumingId !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreTarget(null);
        }}
        onModeChange={setRestoreMode}
        onPermissionModeChange={setRestorePermissionMode}
        onConfirm={() => {
          if (!restoreTarget) return;
          void handleResume(restoreTarget, restoreMode, restorePermissionMode);
        }}
      />
    </div>
  );
}

function historyProjectGroupKey(provider: SessionProvider, dir: string): string {
  return `${provider}:${normalizeHistoryProjectDir(dir)}`;
}

function normalizeHistoryProjectDir(dir: string): string {
  const trimmed = dir.trim();
  if (!trimmed || trimmed === "/") return trimmed || "/";
  return trimmed.replace(/\/+$/, "") || "/";
}

function availableRestoreModes(session: HistorySession): RestoreMode[] {
  const provider = historySessionProvider(session);
  return provider === "codex" ? ["pty"] : ["json", "pty"];
}

function defaultRestoreMode(session: HistorySession): RestoreMode {
  const modes = availableRestoreModes(session);
  if (session.preferredMode && modes.includes(session.preferredMode)) return session.preferredMode;
  return modes[0] ?? "json";
}

function HistoryRestoreDialog({
  session,
  open,
  modes,
  mode,
  permissionMode,
  submitting,
  onOpenChange,
  onModeChange,
  onPermissionModeChange,
  onConfirm,
}: {
  session: HistorySession | null;
  open: boolean;
  modes: RestoreMode[];
  mode: RestoreMode;
  permissionMode: RestorePermissionMode;
  submitting: boolean;
  onOpenChange: (open: boolean) => void;
  onModeChange: (mode: RestoreMode) => void;
  onPermissionModeChange: (mode: RestorePermissionMode) => void;
  onConfirm: () => void;
}) {
  const terminalSelected = mode === "pty";
  const confirmLabel = terminalSelected ? "恢复终端" : "恢复聊天";
  const destructiveConfirm = permissionMode === "bypassPermissions" && terminalSelected;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-slot="history-restore-dialog">
        <DialogHeader>
          <DialogTitle>恢复会话</DialogTitle>
          <DialogDescription className="truncate" title={session?.title}>
            {session?.title ?? ""}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <span className="text-sm font-medium">模式</span>
            <div role="radiogroup" aria-label="恢复模式" className="grid grid-cols-2 gap-2">
              {modes.includes("json") && (
                <RestoreChoiceButton
                  checked={mode === "json"}
                  label="聊天"
                  icon={<MessageSquare className="size-4" aria-hidden="true" />}
                  disabled={submitting}
                  onClick={() => onModeChange("json")}
                />
              )}
              {modes.includes("pty") && (
                <RestoreChoiceButton
                  checked={mode === "pty"}
                  label="终端"
                  icon={<TerminalSquare className="size-4" aria-hidden="true" />}
                  disabled={submitting}
                  onClick={() => onModeChange("pty")}
                />
              )}
            </div>
          </div>
          {terminalSelected && (
            <div className="grid gap-2">
              <span className="text-sm font-medium">权限模式</span>
              <div role="radiogroup" aria-label="权限模式" className="grid gap-2">
                <PermissionChoiceButton
                  checked={permissionMode === "default"}
                  label="严格审批"
                  description="所有需要权限的操作都要确认。"
                  disabled={submitting}
                  onClick={() => onPermissionModeChange("default")}
                />
                <PermissionChoiceButton
                  checked={permissionMode === "auto"}
                  label="自动判定"
                  description="交给 Agent CLI 的原生策略判断。"
                  disabled={submitting}
                  onClick={() => onPermissionModeChange("auto")}
                />
                <PermissionChoiceButton
                  checked={permissionMode === "bypassPermissions"}
                  label="跳过全部审批"
                  description="危险模式，会跳过工具审批和部分沙箱保护。"
                  destructive
                  disabled={submitting}
                  onClick={() => onPermissionModeChange("bypassPermissions")}
                />
              </div>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={submitting}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant={destructiveConfirm ? "destructive" : "default"}
            className={
              destructiveConfirm
                ? "!bg-destructive !text-white hover:!bg-destructive/90 hover:!text-white"
                : undefined
            }
            style={
              destructiveConfirm
                ? { backgroundColor: "var(--destructive)", color: "#fff" }
                : undefined
            }
            disabled={submitting}
            onClick={onConfirm}
          >
            {submitting ? "恢复中..." : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreChoiceButton({
  checked,
  label,
  icon,
  disabled,
  onClick,
}: {
  checked: boolean;
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid h-10 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md border px-3 text-sm outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60",
        checked
          ? "border-primary text-foreground"
          : "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 text-center">{label}</span>
      <Check
        className={cn(
          "size-3.5 justify-self-end transition-opacity",
          checked ? "opacity-100" : "opacity-0",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

function PermissionChoiceButton({
  checked,
  label,
  description,
  destructive,
  disabled,
  onClick,
}: {
  checked: boolean;
  label: string;
  description: string;
  destructive?: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-md border p-3 text-left outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60",
        checked
          ? destructive
            ? "border-destructive/70"
            : "border-primary"
          : "border-border hover:bg-accent/60",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          checked
            ? destructive
              ? "border-destructive"
              : "border-primary"
            : "border-muted-foreground/50",
        )}
        aria-hidden="true"
      >
        {checked && (
          <span
            className={cn("size-2 rounded-full", destructive ? "bg-destructive" : "bg-primary")}
          />
        )}
      </span>
      <span className="grid gap-1">
        <span
          className={cn(
            "text-sm font-medium",
            destructive ? "text-destructive" : "text-foreground",
          )}
        >
          {label}
        </span>
        <span className="text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
      {checked && (
        <Check
          className={cn(
            "mt-0.5 size-4 shrink-0",
            destructive ? "text-destructive" : "text-primary",
          )}
          aria-hidden="true"
        />
      )}
    </button>
  );
}
