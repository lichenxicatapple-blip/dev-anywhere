import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "@/stores/app-store";
import type { ToolApprovalRequest } from "@/stores/chat-store";
import { CursorAskQuestionCard } from "./cursor-ask-question-card";

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
    requestId: "q-1",
    toolName: "AskQuestion",
    input: {},
    status: "pending",
    cursorPrompt: {
      type: "ask_question",
      title: "Need input",
      questions: [
        {
          id: "q1",
          prompt: "Which mode?",
          options: [
            { id: "agent", label: "Agent" },
            { id: "plan", label: "Plan" },
          ],
        },
      ],
    },
  };
}

describe("CursorAskQuestionCard", () => {
  it("submits selected answers", async () => {
    useAppStore.setState({ connected: true, proxyOnline: true });
    sendControl.mockReturnValue(true);
    render(<CursorAskQuestionCard approval={makeApproval()} sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    await waitFor(() =>
      expect(sendControl).toHaveBeenCalledWith({
        type: "tool_approve",
        sessionId: "s1",
        payload: {
          toolId: "q-1",
          cursorAnswer: {
            type: "ask_question",
            outcome: "answered",
            answers: [{ questionId: "q1", selectedOptionIds: ["agent"] }],
          },
        },
      }),
    );
  });

  it("can skip the question", async () => {
    useAppStore.setState({ connected: true, proxyOnline: true });
    sendControl.mockReturnValue(true);
    render(<CursorAskQuestionCard approval={makeApproval()} sessionId="s1" />);
    fireEvent.click(screen.getByRole("button", { name: "跳过" }));
    await waitFor(() =>
      expect(sendControl).toHaveBeenCalledWith({
        type: "tool_deny",
        sessionId: "s1",
        payload: {
          toolId: "q-1",
          cursorAnswer: { type: "ask_question", outcome: "skipped" },
        },
      }),
    );
  });
});
