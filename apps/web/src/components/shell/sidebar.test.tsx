import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar";
import { useAppStore } from "@/stores/app-store";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("@/components/proxy/proxy-switcher", () => ({
  ProxySwitcher: () => <div data-testid="proxy-switcher" />,
}));

vi.mock("@/components/session/session-list", () => ({
  CreateSessionButton: ({ compact }: { compact?: boolean }) => (
    <button type="button" data-compact={compact ? "true" : "false"}>
      新建会话
    </button>
  ),
  SessionList: () => <div data-testid="session-list" />,
}));

vi.mock("@/components/shell/settings-dialog", () => ({
  SettingsDialog: () => null,
}));

describe("Sidebar", () => {
  afterEach(() => {
    cleanup();
    useAppStore.setState({ sidebarCollapsed: false });
  });

  it("keeps the expanded sidebar below standalone app status bars", () => {
    useAppStore.setState({ sidebarCollapsed: false });

    const { container } = render(
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText("侧边栏").className).toContain("pt-[env(safe-area-inset-top)]");
    expect(container.querySelector('[data-slot="sidebar-session-list"]')?.className).toContain(
      "min-h-0",
    );
    expect(container.querySelector('[data-slot="sidebar-new-session"]')?.className).toContain(
      "pb-[calc(var(--dev-safe-area-bottom,env(safe-area-inset-bottom))+0.5rem)]",
    );
    expect(container.querySelector('[data-slot="sidebar-new-session"]')?.className).toContain(
      "shrink-0",
    );
  });

  it("keeps the collapsed sidebar rail below standalone app status bars", () => {
    useAppStore.setState({ sidebarCollapsed: true });

    render(
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText("侧边栏").className).toContain(
      "pt-[max(0.5rem,env(safe-area-inset-top))]",
    );
    expect(screen.getByLabelText("侧边栏").className).toContain(
      "pb-[calc(var(--dev-safe-area-bottom,env(safe-area-inset-bottom))+0.5rem)]",
    );
  });

  it("blurs the PTY helper textarea before sidebar interactions", () => {
    useAppStore.setState({ sidebarCollapsed: false });
    const textarea = document.createElement("textarea");
    textarea.className = "xterm-helper-textarea";
    document.body.appendChild(textarea);
    textarea.focus();

    render(
      <TooltipProvider>
        <Sidebar />
      </TooltipProvider>,
    );

    fireEvent.pointerDown(screen.getByLabelText("侧边栏"));

    expect(document.activeElement).not.toBe(textarea);
    textarea.remove();
  });
});
