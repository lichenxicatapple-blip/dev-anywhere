import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "@/stores/app-store";
import type { ToolApprovalRequest } from "@/stores/chat-store";
import { CursorCreatePlanCard } from "./cursor-create-plan-card";

const { sendControl } = vi.hoisted(() => ({
  sendControl: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    sendControl,
  },
}));

afterEach(() => {
  cleanup();
  sendControl.mockReset();
  useAppStore.setState({ connected: false, proxyOnline: false });
});

function makeApproval(): ToolApprovalRequest {
  return {
    requestId: "plan-1",
    toolName: "CreatePlan",
    input: {},
    status: "pending",
    cursorPrompt: {
      type: "create_plan",
      name: "Refactor tabs",
      overview: "Tighten layout",
      plan: "1. Inspect\n2. Change",
      todos: [{ id: "t1", content: "Inspect", status: "pending" }],
    },
  };
}

describe("CursorCreatePlanCard", () => {
  it("accepts the plan", async () => {
    useAppStore.setState({ connected: true, proxyOnline: true });
    sendControl.mockReturnValue(true);
    render(<CursorCreatePlanCard approval={makeApproval()} sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "接受计划" }));
    await waitFor(() =>
      expect(sendControl).toHaveBeenCalledWith({
        type: "tool_approve",
        sessionId: "s1",
        payload: {
          toolId: "plan-1",
          cursorAnswer: { type: "create_plan", outcome: "accepted" },
        },
      }),
    );
  });
});
