import { fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendControl, onMessage, createSession, createDirectory, toastError } = vi.hoisted(() => ({
  sendControl: vi.fn(),
  onMessage: vi.fn(),
  createSession: vi.fn(),
  createDirectory: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: { sendControl, onMessage, createSession, createDirectory },
  wsManagerRef: null,
}));

vi.mock("@/components/toast", () => ({
  toast: {
    error: toastError,
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
  beforeEach(() => {
    sendControl.mockClear();
    onMessage.mockReset();
    onMessage.mockReturnValue(vi.fn());
    createSession.mockReset();
    createDirectory.mockReset();
    toastError.mockClear();
    useFileStore.setState({
      tree: new Map(),
      cwd: "",
      homePath: "",
    });
  });

  it("requests proxy_info when opened without a cached homePath", async () => {
    renderDialog();

    await waitFor(() => {
      expect(sendControl).toHaveBeenCalledWith({ type: "proxy_info_request" });
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
    expect(sendControl).not.toHaveBeenCalledWith({ type: "proxy_info_request" });
  });

  it("unblocks the create button when session creation times out", async () => {
    createSession.mockRejectedValue(new Error("创建超时，请检查本机连接后重试"));
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
    expect(toastError).toHaveBeenCalledWith("创建超时，请检查本机连接后重试");
  });

  it("offers to create a missing working directory and retries session creation", async () => {
    createSession
      .mockResolvedValueOnce({
        type: "session_create_response",
        sessionId: "",
        error: "工作目录不存在或不可访问: /Users/admin/missing-project",
      })
      .mockResolvedValueOnce({
        type: "session_create_response",
        sessionId: "created-1",
        mode: "pty",
        provider: "claude",
      });
    createDirectory.mockResolvedValue({
      success: true,
      path: "/Users/admin/missing-project",
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
      expect(getByText("这个目录还不存在")).toBeTruthy();
    });
    fireEvent.click(getByRole("button", { name: "创建目录并继续" }));

    await waitFor(() => {
      expect(createDirectory).toHaveBeenCalledWith("/Users/admin/missing-project");
    });
    await waitFor(() => {
      expect(createSession).toHaveBeenCalledTimes(2);
    });
  });
});
