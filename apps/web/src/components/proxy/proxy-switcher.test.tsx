import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  removeOfflineProxy,
  listProxies,
  clearBoundProxy,
  navigateMock,
  toastError,
  toastInfo,
  toastSuccess,
  toastWarning,
} = vi.hoisted(() => ({
  removeOfflineProxy: vi.fn(),
  listProxies: vi.fn(),
  clearBoundProxy: vi.fn(),
  navigateMock: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    removeOfflineProxy,
    listProxies,
    clearBoundProxy,
  },
}));

vi.mock("@/components/toast", () => ({
  toast: {
    error: toastError,
    info: toastInfo,
    success: toastSuccess,
    warning: toastWarning,
  },
}));

import { useAppStore } from "@/stores/app-store";
import { ProxySwitcher } from "./proxy-switcher";

const proxies = [
  { proxyId: "proxy-online", name: "工作站", online: true, sessions: [] },
  { proxyId: "proxy-offline", name: "旧 Mac", online: false, sessions: [] },
];

function renderSwitcher(layout: "page" | "dropdown") {
  return render(
    <MemoryRouter>
      <ProxySwitcher layout={layout} />
    </MemoryRouter>,
  );
}

function pointerDown(element: HTMLElement): void {
  fireEvent(
    element,
    new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      button: 0,
      ctrlKey: false,
    }),
  );
}

describe("ProxySwitcher offline removal", () => {
  beforeEach(() => {
    removeOfflineProxy.mockReset();
    removeOfflineProxy.mockResolvedValue({
      proxyId: "proxy-offline",
      success: true,
    });
    listProxies.mockReset();
    clearBoundProxy.mockReset();
    navigateMock.mockReset();
    toastError.mockReset();
    toastInfo.mockReset();
    toastSuccess.mockReset();
    toastWarning.mockReset();
    useAppStore.setState({
      proxies,
      proxyListLoaded: true,
      selectedProxyId: "proxy-online",
      selectedProxyName: "工作站",
      proxyOnline: true,
      proxySwitchTarget: null,
      relayClientAuthIssue: null,
    });
  });

  afterEach(async () => {
    cleanup();
    sessionStorage.clear();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("offers removal only on offline rows in the mobile list", () => {
    renderSwitcher("page");

    expect(screen.getByRole("button", { name: "显示移除 旧 Mac 操作" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "显示移除 工作站 操作" })).toBeNull();
    expect(
      document.querySelector('[data-slot="proxy-item"][data-proxy-id="proxy-online"]'),
    ).toHaveAttribute("data-online", "true");
    expect(
      document.querySelector('[data-slot="proxy-item"][data-proxy-id="proxy-offline"]'),
    ).toHaveAttribute("data-online", "false");
  });

  it("confirms the reconnect semantics before removing an offline mobile row", async () => {
    renderSwitcher("page");
    fireEvent.click(screen.getByRole("button", { name: "显示移除 旧 Mac 操作" }));
    fireEvent.click(screen.getByRole("button", { name: "移除 旧 Mac" }));

    expect(screen.getByRole("heading", { name: "移除离线开发机？" })).toBeVisible();
    expect(screen.getByText(/不会阻止它再次连接/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    await waitFor(() => expect(removeOfflineProxy).toHaveBeenCalledWith("proxy-offline"));
    expect(toastSuccess).toHaveBeenCalledWith("已移除 旧 Mac");
  });

  it("shows a desktop overflow menu only for the offline row", async () => {
    renderSwitcher("dropdown");
    fireEvent.click(screen.getByRole("button", { name: "当前连接：工作站" }));

    const offlineMenu = await screen.findByRole("button", { name: "旧 Mac 操作" });
    expect(screen.queryByRole("button", { name: "工作站 操作" })).toBeNull();

    pointerDown(offlineMenu);
    fireEvent.click(offlineMenu);
    const removeItem = await screen.findByText("移除开发机");
    fireEvent.click(removeItem);

    expect(await screen.findByRole("heading", { name: "移除离线开发机？" })).toBeVisible();
  });

  it("refuses a stale confirmation when the device has already come back online", async () => {
    renderSwitcher("page");
    fireEvent.click(screen.getByRole("button", { name: "显示移除 旧 Mac 操作" }));
    fireEvent.click(screen.getByRole("button", { name: "移除 旧 Mac" }));
    useAppStore.setState({
      proxies: proxies.map((proxy) =>
        proxy.proxyId === "proxy-offline" ? { ...proxy, online: true } : proxy,
      ),
    });

    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    expect(removeOfflineProxy).not.toHaveBeenCalled();
    expect(toastWarning).toHaveBeenCalledWith("这台开发机已重新上线，未移除");
  });
});
