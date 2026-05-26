import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const { sendControl } = vi.hoisted(() => ({
  sendControl: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    sendControl,
  },
}));

import { ToolApprovalCard } from "./tool-approval-card";
import type { ToolApprovalRequest } from "@/stores/chat-store";
import { useAppStore } from "@/stores/app-store";

afterEach(() => {
  cleanup();
  sendControl.mockReset();
  useAppStore.setState({ connected: false, proxyOnline: false });
});

function makeApproval(overrides: Partial<ToolApprovalRequest> = {}): ToolApprovalRequest {
  return {
    requestId: "tool-1",
    toolName: "Bash",
    input: {
      command:
        "ls -la /Users/catli/MyApps/CyberVita/11m /Users/catli/MyApps/CyberVita/11m/proxy /Users/catli/MyApps/CyberVita/11m/apps",
    },
    status: "pending",
    ...overrides,
  };
}

describe("ToolApprovalCard", () => {
  function markTransportReady() {
    useAppStore.setState({ connected: true, proxyOnline: true });
    sendControl.mockReturnValue(true);
  }

  it("keeps inline approval cards constrained to the same rail as JSON messages", () => {
    const { container } = render(
      <ToolApprovalCard approval={makeApproval()} sessionId="s1" container="inline" />,
    );

    const row = container.querySelector<HTMLElement>('[data-slot="tool-approval-row"]');
    const card = screen.getByRole("region", { name: /工具审批: Bash/ });
    const summary = container.querySelector<HTMLElement>('[data-slot="tool-approval-summary"]');

    expect(row).not.toBeNull();
    expect(summary).not.toBeNull();
    expect(row?.className).toContain("dev-message-rail");
    expect(row?.className).toContain("mx-auto");
    expect(row?.className).toContain("w-full");
    expect(row?.className).toContain("min-w-0");
    expect(card.className).toContain("w-full");
    expect(card.className).toContain("min-w-0");
    expect(card.className).toContain("max-w-full");
    expect(summary?.className).toContain("min-w-0");
    expect(summary?.className).toContain("truncate");
  });

  it("sends a session whitelist approval when Always Allow is clicked", async () => {
    markTransportReady();

    render(<ToolApprovalCard approval={makeApproval()} sessionId="s1" container="inline" />);
    fireEvent.click(screen.getByRole("button", { name: /^始终允许$/ }));

    await waitFor(() =>
      expect(sendControl).toHaveBeenCalledWith({
        type: "tool_approve",
        sessionId: "s1",
        payload: { toolId: "tool-1", whitelistTool: true },
      }),
    );
  });

  it("sends a one-shot approval when Allow is clicked", async () => {
    markTransportReady();

    render(<ToolApprovalCard approval={makeApproval()} sessionId="s1" container="inline" />);
    fireEvent.click(screen.getByRole("button", { name: /^允许$/ }));

    await waitFor(() =>
      expect(sendControl).toHaveBeenCalledWith({
        type: "tool_approve",
        sessionId: "s1",
        payload: { toolId: "tool-1", whitelistTool: false },
      }),
    );
  });

  it("shows approval queue position when multiple tool approvals are pending", () => {
    render(
      <ToolApprovalCard
        approval={makeApproval()}
        sessionId="s1"
        container="inline"
        queuePosition={2}
        queueSize={3}
      />,
    );

    expect(screen.getByText("2/3")).not.toBeNull();
    expect(screen.getByLabelText("第 2 个审批，共 3 个")).not.toBeNull();
  });

  it("renders Edit approval details as a diff preview instead of raw parameter JSON", () => {
    const { container } = render(
      <ToolApprovalCard
        approval={makeApproval({
          toolName: "Edit",
          input: {
            file_path: "/tmp/result.txt",
            old_string: "same\nold",
            new_string: "same\nnew",
          },
        })}
        sessionId="s1"
        container="inline"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开详情" }));

    expect(container.querySelector('[data-slot="tool-approval-preview"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="tool-approval-json"]')).toBeNull();
    expect(
      container.querySelectorAll('[data-slot="activity-diff-row"][data-kind="remove"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-slot="activity-diff-row"][data-kind="add"]'),
    ).toHaveLength(1);
  });
});
