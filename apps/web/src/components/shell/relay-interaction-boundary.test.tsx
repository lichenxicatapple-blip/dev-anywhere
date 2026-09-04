import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RelayInteractionBoundary } from "./relay-interaction-boundary";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

function PortalHarness({ blocked }: { blocked: boolean }) {
  return (
    <RelayInteractionBoundary blocked={blocked}>
      <Dialog open modal={false}>
        <DialogContent showCloseButton={false}>
          <DialogTitle>测试弹窗</DialogTitle>
          <DialogDescription>测试 Relay 覆盖层期间的弹窗状态。</DialogDescription>
          <input aria-label="弹窗内容" defaultValue="dialog initial" />
        </DialogContent>
      </Dialog>
      <Sheet open modal={false}>
        <SheetContent showCloseButton={false}>
          <SheetTitle>测试抽屉</SheetTitle>
          <SheetDescription>测试 Relay 覆盖层期间的抽屉状态。</SheetDescription>
          <input aria-label="抽屉内容" defaultValue="sheet initial" />
        </SheetContent>
      </Sheet>
    </RelayInteractionBoundary>
  );
}

function DropdownPortalHarness({ blocked }: { blocked: boolean }) {
  return (
    <RelayInteractionBoundary blocked={blocked}>
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>打开菜单</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>执行操作</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </RelayInteractionBoundary>
  );
}

describe("RelayInteractionBoundary", () => {
  afterEach(() => cleanup());

  it("blocks open Radix dialog and sheet portals without discarding their state", () => {
    const view = render(<PortalHarness blocked={false} />);
    const dialogInput = screen.getByLabelText<HTMLInputElement>("弹窗内容");
    const sheetInput = screen.getByLabelText<HTMLInputElement>("抽屉内容");
    const dialogContent = document.querySelector('[data-slot="dialog-content"]');
    const sheetContent = document.querySelector('[data-slot="sheet-content"]');

    expect(dialogContent).not.toHaveAttribute("inert");
    expect(sheetContent).not.toHaveAttribute("inert");
    fireEvent.change(dialogInput, { target: { value: "dialog edited" } });
    fireEvent.change(sheetInput, { target: { value: "sheet edited" } });

    view.rerender(<PortalHarness blocked />);

    expect(dialogContent).toHaveAttribute("inert");
    expect(dialogContent).toHaveAttribute("aria-disabled", "true");
    expect(sheetContent).toHaveAttribute("inert");
    expect(sheetContent).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText<HTMLInputElement>("弹窗内容")).toHaveValue("dialog edited");
    expect(screen.getByLabelText<HTMLInputElement>("抽屉内容")).toHaveValue("sheet edited");

    view.rerender(<PortalHarness blocked={false} />);

    expect(dialogContent).not.toHaveAttribute("inert");
    expect(dialogContent).not.toHaveAttribute("aria-disabled");
    expect(sheetContent).not.toHaveAttribute("inert");
    expect(sheetContent).not.toHaveAttribute("aria-disabled");
    expect(screen.getByLabelText<HTMLInputElement>("弹窗内容")).toHaveValue("dialog edited");
    expect(screen.getByLabelText<HTMLInputElement>("抽屉内容")).toHaveValue("sheet edited");
  });

  it("blocks an open Radix dropdown portal and restores it after reconnect", () => {
    const view = render(<DropdownPortalHarness blocked={false} />);
    const menuContent = document.querySelector('[data-slot="dropdown-menu-content"]');
    const menuItem = screen.getByText("执行操作");

    expect(menuContent).not.toHaveAttribute("inert");
    expect(menuItem).toBeVisible();

    view.rerender(<DropdownPortalHarness blocked />);

    expect(menuContent).toHaveAttribute("inert");
    expect(menuContent).toHaveAttribute("aria-disabled", "true");
    expect(menuContent).toHaveAttribute("data-relay-interaction-blocked", "true");
    expect(screen.getByText("执行操作")).toBe(menuItem);

    view.rerender(<DropdownPortalHarness blocked={false} />);

    expect(menuContent).not.toHaveAttribute("inert");
    expect(menuContent).not.toHaveAttribute("aria-disabled");
    expect(menuContent).not.toHaveAttribute("data-relay-interaction-blocked");
    expect(screen.getByText("执行操作")).toBe(menuItem);
  });
});
