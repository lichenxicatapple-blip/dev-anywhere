import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendControl } = vi.hoisted(() => ({
  sendControl: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: { sendControl },
  wsManagerRef: null,
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
});
