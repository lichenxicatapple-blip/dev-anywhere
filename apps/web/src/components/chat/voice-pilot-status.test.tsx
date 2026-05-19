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
    useVoicePilotStore.getState().setPhase("s1", "speaking");

    const { container } = render(
      <TooltipProvider>
        <VoicePilotStatus sessionId="s1" />
      </TooltipProvider>,
    );

    expect(screen.getByText("Voice Pilot")).not.toBeNull();
    expect(screen.getByText("正在播报")).not.toBeNull();
    expect(screen.getByText("播报")).not.toBeNull();
    expect(
      container
        .querySelector('[data-slot="voice-pilot-waveform"]')
        ?.getAttribute("data-activity-level"),
    ).toBe("72");
    expect(container.querySelector('[data-slot="voice-pilot-waveform-curve"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="voice-pilot-meter-readout"]')).toBeNull();
    expect(container.querySelector(".dev-voice-waveform-scan")).toBeNull();
    expect(
      container.querySelector('[data-slot="voice-pilot-status"]')?.getAttribute("data-tone"),
    ).toBe("speak");
    const stopButton = screen.getByRole("button", { name: "停止 Voice Pilot" });
    expect(stopButton.textContent).toBe("");
    expect(stopButton.className).toContain("size-8");
    fireEvent.click(stopButton);

    expect(useVoicePilotStore.getState().bySessionId.s1).toMatchObject({
      enabled: false,
      phase: "idle",
    });
  });
});
