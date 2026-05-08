import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  sendControl,
  onMessage,
  createSession,
  createDirectory,
  requestDirectoryList,
  requestProxyInfo,
  toastError,
  toastSuccess,
} = vi.hoisted(() => ({
  sendControl: vi.fn(),
  onMessage: vi.fn(),
  createSession: vi.fn(),
  createDirectory: vi.fn(),
  requestDirectoryList: vi.fn(),
  requestProxyInfo: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    sendControl,
    onMessage,
    createSession,
    createDirectory,
    requestDirectoryList,
    requestProxyInfo,
  },
  wsManagerRef: null,
}));

vi.mock("@/components/toast", () => ({
  toast: {
    error: toastError,
    success: toastSuccess,
  },
}));

import { useFileStore } from "@/stores/file-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CreateSessionDialog } from "./create-session-dialog";

function renderDialog() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <CreateSessionDialog open onOpenChange={vi.fn()} />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe("CreateSessionDialog", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    sendControl.mockClear();
    onMessage.mockReset();
    onMessage.mockReturnValue(vi.fn());
    createSession.mockReset();
    createDirectory.mockReset();
    requestDirectoryList.mockReset();
    requestDirectoryList.mockResolvedValue({ path: "/Users/admin", entries: [] });
    requestProxyInfo.mockReset();
    requestProxyInfo.mockResolvedValue({ homePath: "/Users/admin" });
    toastError.mockClear();
    toastSuccess.mockClear();
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "",
    });
  });

  it("requests proxy_info when opened without a cached homePath", async () => {
    renderDialog();

    await waitFor(() => {
      expect(requestProxyInfo).toHaveBeenCalled();
      expect(useFileStore.getState().homePath).toBe("/Users/admin");
    });
  });

  it("uses homePath as the default working directory when it is already cached", async () => {
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/Users/admin",
    });

    const { getByLabelText } = renderDialog();

    await waitFor(() => {
      expect((getByLabelText("工作目录") as HTMLInputElement).value).toBe("/Users/admin");
    });
  });

  it("unblocks the create button when session creation times out", async () => {
    createSession.mockRejectedValue(new Error("创建超时，请检查开发机连接后重试"));
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/Users/admin",
    });

    const { getByRole } = renderDialog();
    const createButton = getByRole("button", { name: "创建" });

    fireEvent.click(createButton);
    expect((getByRole("button", { name: "创建中..." }) as HTMLButtonElement).disabled).toBe(true);

    await waitFor(() => {
      expect((getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled).toBe(false);
    });
    expect(toastError).toHaveBeenCalledWith("创建超时，请检查开发机连接后重试");
  });

  it("does not create a missing working directory as a side effect of session creation", async () => {
    createSession.mockResolvedValueOnce({
      type: "session_create_response",
      sessionId: "",
      errorCode: "PATH_NOT_FOUND",
      error: "工作目录不存在或不可访问: /Users/admin/missing-project",
    });
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/Users/admin",
    });

    const { getByLabelText, getByRole, getByText } = renderDialog();

    const cwdInput = getByLabelText("工作目录") as HTMLInputElement;
    await waitFor(() => {
      expect(cwdInput.value).toBe("/Users/admin");
    });
    fireEvent.change(cwdInput, { target: { value: "/Users/admin/missing-project" } });
    fireEvent.click(getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(getByText("工作目录不存在")).toBeTruthy();
    });
    expect(toastError).toHaveBeenCalledWith("找不到这个工作目录");
    expect(createDirectory).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it("creates a directory from the directory picker without creating a session", async () => {
    createDirectory.mockResolvedValue({
      success: true,
      path: "/Users/admin/new-project",
    });
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "/Users/admin",
    });

    const { getByLabelText, getByPlaceholderText } = renderDialog();

    const cwdInput = getByLabelText("工作目录") as HTMLInputElement;
    await waitFor(() => {
      expect(cwdInput.value).toBe("/Users/admin");
    });
    fireEvent.focusIn(cwdInput);
    let picker: HTMLElement | null = null;
    await waitFor(() => {
      picker = document.querySelector<HTMLElement>('[data-slot="file-path-picker"]');
      expect(picker).toBeTruthy();
    });
    if (!picker) throw new Error("directory picker did not open");
    fireEvent.click(within(picker).getByRole("button", { name: "新建目录" }));
    fireEvent.change(getByPlaceholderText("目录名称"), {
      target: { value: "new-project" },
    });
    fireEvent.click(within(picker).getByRole("button", { name: "创建目录" }));

    await waitFor(() => {
      expect(createDirectory).toHaveBeenCalledWith("/Users/admin/new-project");
    });
    await waitFor(() => {
      expect(cwdInput.value).toBe("/Users/admin/new-project/");
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(toastSuccess).toHaveBeenCalledWith("目录已创建");
  });
});
