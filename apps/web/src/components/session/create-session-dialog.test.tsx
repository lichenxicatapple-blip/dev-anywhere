import { act } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendControl, onMessage, toastError } = vi.hoisted(() => ({
  sendControl: vi.fn(),
  onMessage: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: { sendControl, onMessage },
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

  it("unblocks the create button when session_create_response never arrives", async () => {
    vi.useFakeTimers();
    try {
      const unsubscribe = vi.fn();
      onMessage.mockReturnValue(unsubscribe);
      useFileStore.setState({
        tree: new Map(),
        cwd: "",
        homePath: "/Users/admin",
      });

      const { getByRole } = renderDialog();
      const createButton = getByRole("button", { name: "创建" });

      fireEvent.click(createButton);
      expect((getByRole("button", { name: "创建中..." }) as HTMLButtonElement).disabled).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(15_000);
      });

      expect((getByRole("button", { name: "创建" }) as HTMLButtonElement).disabled).toBe(false);
      expect(unsubscribe).toHaveBeenCalled();
      expect(toastError).toHaveBeenCalledWith("创建超时，请检查本机连接后重试");
    } finally {
      vi.useRealTimers();
    }
  });
});
