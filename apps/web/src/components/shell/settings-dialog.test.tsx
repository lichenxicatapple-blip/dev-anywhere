import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./settings-dialog";

describe("SettingsDialog", () => {
  afterEach(() => cleanup());

  it("shows version and voice settings entries, with voice as an empty page", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "设置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /版本/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: /语音识别及合成/ })).not.toBeNull();
    const menuItems = screen.getAllByRole("button").filter((button) => {
      return button.getAttribute("data-slot") === "settings-menu-item";
    });
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "语音识别及合成语音输入与朗读设置",
      "版本查看 Web 和 Relay 版本",
    ]);

    fireEvent.click(screen.getByRole("button", { name: /语音识别及合成/ }));

    expect(screen.getByRole("heading", { name: "语音识别及合成" })).not.toBeNull();
    expect(screen.queryByText(/会放在这里/)).toBeNull();
    expect(screen.queryByText("即将推出")).toBeNull();
  });
});
