import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VoicePilotStatus } from "./voice-pilot-status";
import { useVoicePilotStore } from "@/voice/voice-pilot-store";

describe("VoicePilotStatus", () => {
  beforeEach(() => {
    useVoicePilotStore.getState().resetAll();
  });

  afterEach(() => cleanup());

  it("stays hidden while Voice Pilot is disabled", () => {
    const { container } = render(<VoicePilotStatus sessionId="s1" />);

    expect(container.querySelector('[data-slot="voice-pilot-status"]')).toBeNull();
  });

  it("shows the current state and can stop Voice Pilot", () => {
    useVoicePilotStore.getState().enable("s1");
    useVoicePilotStore.getState().setActivityLevel("s1", 0.72);
    useVoicePilotStore.getState().appendWaveform("s1", [
      { min: -0.25, max: 0.5 },
      { min: -0.5, max: 0.25 },
    ]);
    useVoicePilotStore.getState().setPhase("s1", "speaking");

    const { container } = render(
      <TooltipProvider>
        <VoicePilotStatus sessionId="s1" />
      </TooltipProvider>,
    );

    expect(screen.getByText("Voice Pilot")).not.toBeNull();
    expect(screen.getByText("播报")).not.toBeNull();
    expect(screen.queryByText("正在播报")).toBeNull();
    expect(
      container
        .querySelector('[data-slot="voice-pilot-waveform"]')
        ?.getAttribute("data-activity-level"),
    ).toBe("72");
    expect(
      container
        .querySelector('[data-slot="voice-pilot-waveform"]')
        ?.getAttribute("data-waveform-bins"),
    ).toBe("2");
    expect(
      container.querySelector('[data-slot="voice-pilot-waveform-curve"]')?.getAttribute("d"),
    ).toContain("L");
    expect(
      container.querySelector('[data-slot="voice-pilot-status"]')?.getAttribute("data-tone"),
    ).toBe("speak");
    const stopButton = screen.getByRole("button", { name: "停止 Voice Pilot" });
    expect(stopButton.textContent).toBe("");
    expect(stopButton.querySelector("svg")).not.toBeNull();
    fireEvent.click(stopButton);

    expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
      enabled: false,
      phase: "idle",
    });
  });

  it("shows concrete error text instead of repeating the error chip", () => {
    useVoicePilotStore.getState().enable("s1");
    useVoicePilotStore.getState().setError("s1", "语音识别连接不可用");

    render(
      <TooltipProvider>
        <VoicePilotStatus sessionId="s1" />
      </TooltipProvider>,
    );

    expect(screen.getByText("异常")).not.toBeNull();
    expect(screen.getByText("语音识别连接不可用")).not.toBeNull();
    expect(screen.queryByText("需要处理")).toBeNull();
  });
});
