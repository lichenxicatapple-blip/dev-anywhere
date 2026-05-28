import { useState } from "react";
import { PanelLeftClose, PanelLeftOpen, Settings } from "lucide-react";
import { BrandMark } from "@/components/brand/brand-mark";
import { useAppStore } from "@/stores/app-store";
import { ProxySwitcher } from "@/components/proxy/proxy-switcher";
import { SessionList, CreateSessionButton } from "@/components/session/session-list";
import { SettingsDialog } from "@/components/shell/settings-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface SidebarProps {
  className?: string;
}

export function Sidebar({ className }: SidebarProps) {
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebarCollapsed = useAppStore((s) => s.toggleSidebarCollapsed);
  const [settingsOpen, setSettingsOpen] = useState(false);

  if (collapsed) {
    return (
      <>
        <nav
          className={cn(
            "dev-sidebar-shell dev-sidebar-rail relative flex-col items-center w-12 shrink-0 bg-card border-r border-border overflow-hidden px-1.5 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-[max(0.5rem,env(safe-area-inset-top))]",
            className,
          )}
          aria-label="侧边栏"
          data-slot="sidebar-rail"
          data-collapsed="true"
        >
          <SidebarToggle collapsed onClick={toggleSidebarCollapsed} />
          <div className="mt-3 h-px w-5 bg-border/70" aria-hidden="true" />
          <div className="mt-auto flex flex-col gap-2">
            <SidebarSettingsButton
              compact
              tooltipSide="right"
              onClick={() => setSettingsOpen(true)}
            />
            <CreateSessionButton compact />
          </div>
        </nav>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </>
    );
  }

  return (
    <>
      <nav
        className={cn(
          "dev-sidebar-shell group/sidebar relative flex-col w-[280px] shrink-0 bg-card border-r border-border overflow-visible pt-[env(safe-area-inset-top)]",
          className,
        )}
        aria-label="侧边栏"
        data-slot="sidebar"
        data-collapsed="false"
      >
        <div className="dev-sidebar-fade p-2.5" data-slot="sidebar-proxy-switcher">
          <div className="dev-sidebar-chrome rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <BrandMark className="text-[13px]" slot="sidebar-brand" />
              <SidebarToggle collapsed={false} onClick={toggleSidebarCollapsed} />
            </div>
            <div className="mt-2.5">
              <ProxySwitcher layout="dropdown" variant="sidebarChrome" />
            </div>
          </div>
        </div>

        <div
          className="dev-sidebar-fade flex flex-col flex-1 overflow-hidden"
          data-slot="sidebar-session-list"
        >
          <div className="flex-1 min-h-0">
            <SessionList layout="sidebar" />
          </div>
        </div>

        <div
          className="dev-sidebar-fade flex gap-2 px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2"
          data-slot="sidebar-new-session"
        >
          <div className="min-w-0 flex-1">
            <CreateSessionButton />
          </div>
          <SidebarSettingsButton onClick={() => setSettingsOpen(true)} />
        </div>
      </nav>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </>
  );
}

function SidebarSettingsButton({
  compact = false,
  tooltipSide = "top",
  onClick,
}: {
  compact?: boolean;
  tooltipSide?: "top" | "right";
  onClick: () => void;
}) {
  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="设置"
          data-slot="sidebar-settings-trigger"
          onClick={onClick}
          className={cn(
            "inline-flex items-center justify-center shrink-0 border border-border text-muted-foreground outline-none transition-[color,background-color,border-color,box-shadow]",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            compact
              ? "h-11 w-11 rounded-md bg-card/70 hover:border-primary/60 hover:bg-accent hover:text-foreground"
              : "h-[46px] w-[46px] rounded-md bg-background hover:bg-accent hover:text-foreground",
          )}
        >
          <Settings className="size-4" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={tooltipSide}
        sideOffset={10}
        hideArrow
        className="border border-border/80 bg-card/95 px-2.5 py-1 text-muted-foreground shadow-sm backdrop-blur"
      >
        设置
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarToggle({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  const label = collapsed ? "展开侧边栏" : "收起侧边栏";
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-slot={collapsed ? "sidebar-expand-trigger" : "sidebar-collapse-trigger"}
          onClick={onClick}
          className={cn(
            "group inline-flex items-center justify-center text-muted-foreground outline-none transition-[opacity,color,background-color,border-color,box-shadow,transform]",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            collapsed
              ? "h-9 w-9 rounded-md border border-border/80 bg-card/70 hover:border-primary/60 hover:bg-accent hover:text-foreground"
              : "h-9 w-9 rounded-full border border-primary/25 bg-primary/10 hover:border-primary/60 hover:bg-primary/15 hover:text-foreground",
          )}
        >
          <Icon
            className={cn(
              "size-3.5 transition-transform",
              collapsed && "group-hover:translate-x-0.5",
              !collapsed && "group-hover:-translate-x-0.5",
            )}
            aria-hidden="true"
          />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side={collapsed ? "right" : "top"}
        sideOffset={10}
        hideArrow
        className="border border-border/80 bg-card/95 px-2.5 py-1 text-muted-foreground shadow-sm backdrop-blur"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
