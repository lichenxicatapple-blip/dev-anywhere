import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  playerEnqueue,
  playerStop,
  requestVoiceCapabilities,
  requestVoiceConfig,
  testVoiceConfig,
  updateVoiceConfig,
} = vi.hoisted(() => ({
  playerEnqueue: vi.fn(),
  playerStop: vi.fn(),
  requestVoiceCapabilities: vi.fn(),
  requestVoiceConfig: vi.fn(),
  testVoiceConfig: vi.fn(),
  updateVoiceConfig: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    requestVoiceCapabilities,
    requestVoiceConfig,
    testVoiceConfig,
    updateVoiceConfig,
  },
  wsManagerRef: null,
}));

vi.mock("@/voice/pcm-stream-player", () => ({
  PcmStreamPlayer: class {
    enqueue = playerEnqueue;
    stop = playerStop;
  },
}));

import { SettingsDialog } from "./settings-dialog";
import { useAppStore } from "@/stores/app-store";

function chooseVoiceSetting(label: string, optionName: string) {
  fireEvent.click(screen.getByRole("button", { name: label }));
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

describe("SettingsDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
    localStorage.clear();
    useAppStore.setState({ desktopInteractionMode: false, latencyMonitorEnabled: false });
    playerEnqueue.mockReset();
    playerStop.mockReset();
    requestVoiceCapabilities.mockReset();
    requestVoiceCapabilities.mockResolvedValue({
      capabilities: {
        asrModels: [
          {
            value: "qwen3-asr-flash-realtime-live",
            label: "Qwen3 ASR · 动态实时",
            source: "official",
          },
        ],
        ttsModels: [
          {
            value: "cosyvoice-v3-flash-live",
            label: "CosyVoice V3 Flash · 动态",
            source: "official",
          },
        ],
        ttsVoices: [
          {
            value: "longanhuan-live",
            label: "龙安欢 · 女 · 动态元气 · 20-30",
            gender: "female",
            age: "20-30",
            model: "cosyvoice-v3-flash-live",
            source: "official",
          },
          {
            value: "longanlang-live",
            label: "龙安朗 · 男 · 动态清爽 · 20-25",
            gender: "male",
            age: "20-25",
            model: "cosyvoice-v3-flash-live",
            source: "official",
          },
        ],
        fetchedAt: 1760000000000,
      },
    });
    requestVoiceConfig.mockReset();
    requestVoiceConfig.mockResolvedValue({
      config: {
        provider: "aliyun-bailian",
        configured: false,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime-live",
        ttsModel: "cosyvoice-v3-flash-live",
        ttsVoice: "longanhuan-live",
        turnIdleSeconds: 3,
      },
    });
    updateVoiceConfig.mockReset();
    testVoiceConfig.mockReset();
    testVoiceConfig.mockResolvedValue({ success: true });
    updateVoiceConfig.mockResolvedValue({
      success: true,
      config: {
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime-live",
        ttsModel: "cosyvoice-v3-flash-live",
        ttsVoice: "longanlang-live",
        turnIdleSeconds: 6,
      },
    });
    vi.stubGlobal(
      "AudioContext",
      vi.fn().mockImplementation(function MockAudioContext() {
        return {
          close: vi.fn(),
          currentTime: 0,
        };
      }),
    );
  });

  it("shows the Voice Pilot settings entry with a subtitle", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "设置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /版本/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Voice Pilot" })).not.toBeNull();
    expect(screen.getByText("用语音输入、听取回复和处理审批")).not.toBeNull();
    expect(screen.getByRole("switch", { name: "桌面交互模式" })).not.toBeNull();
    expect(screen.getByText("适合平板外接键盘；保留触控，但按桌面输入处理")).not.toBeNull();
    const menuItems = screen.getAllByRole("button").filter((button) => {
      return button.getAttribute("data-slot") === "settings-menu-item";
    });
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Voice Pilot用语音输入、听取回复和处理审批",
      "Relay Token未设置；用于连接需要认证的 Relay",
      "版本",
    ]);
  });

  it("persists desktop interaction mode from global settings", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    const toggle = screen.getByRole("switch", { name: "桌面交互模式" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(useAppStore.getState().desktopInteractionMode).toBe(true);
    expect(localStorage.getItem("dev_anywhere_desktopInteractionMode")).toBe("1");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("saves relay client token from settings and reloads to apply it", () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Relay Token" }));
    fireEvent.change(screen.getByLabelText("Relay client token"), {
      target: { value: " client-secret " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(localStorage.getItem("dev_anywhere_relayClientToken")).toBe("client-secret");
    expect(sessionStorage.getItem("dev_anywhere_relayClientToken")).toBe("client-secret");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows saved relay client token state and can clear it from settings", () => {
    localStorage.setItem("dev_anywhere_relayClientToken", "old-token");
    sessionStorage.setItem("dev_anywhere_relayClientToken", "old-token");
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, reload },
    });
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Relay Token" }).textContent).toContain("已保存");
    fireEvent.click(screen.getByRole("button", { name: "Relay Token" }));
    expect(screen.getByText("已保存 token")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清空" }));

    expect(localStorage.getItem("dev_anywhere_relayClientToken")).toBeNull();
    expect(sessionStorage.getItem("dev_anywhere_relayClientToken")).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("loads and saves Bailian Voice Pilot settings without dismissing the dialog", async () => {
    const onOpenChange = vi.fn();
    render(<SettingsDialog open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));

    expect(screen.getByRole("heading", { name: "设置 Voice Pilot" })).not.toBeNull();
    expect(screen.getByText("连接语音服务后，即可以语音交互的形式驱动会话。")).not.toBeNull();
    expect(screen.getByText("阿里云百炼")).not.toBeNull();
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestVoiceCapabilities).toHaveBeenCalledWith({ region: "cn" }));

    fireEvent.change(screen.getByLabelText("阿里云百炼 API Key"), {
      target: { value: "sk-test" },
    });
    chooseVoiceSetting("语音音色", "龙安朗 · 男 · 动态清爽 · 年龄 20-25");
    fireEvent.change(screen.getByLabelText("结束停顿时间（秒）"), {
      target: { value: "6" },
    });
    const saveButton = screen.getByRole("button", { name: "保存" });
    expect(saveButton.querySelector("svg")).not.toBeNull();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(updateVoiceConfig).toHaveBeenCalledWith({
        apiKey: "sk-test",
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime-live",
        ttsModel: "cosyvoice-v3-flash-live",
        ttsVoice: "longanlang-live",
        turnIdleSeconds: 6,
      });
    });
    expect(await screen.findByText("已保存")).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("uses the themed inset scroll area for Voice Pilot settings", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));

    const bodyFrame = document.querySelector<HTMLElement>(
      '[data-slot="voice-settings-body-frame"]',
    );
    const scrollArea = document.querySelector<HTMLElement>('[data-slot="voice-settings-scroll"]');
    const footer = document.querySelector<HTMLElement>('[data-slot="voice-settings-footer"]');
    const divider = document.querySelector<HTMLElement>(
      '[data-slot="voice-settings-header-divider"]',
    );
    const footerDivider = document.querySelector<HTMLElement>(
      '[data-slot="voice-settings-footer-divider"]',
    );
    const fields = document.querySelector<HTMLElement>('[data-slot="voice-settings-fields"]');

    expect(bodyFrame).not.toBeNull();
    expect(scrollArea).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(divider).not.toBeNull();
    expect(footerDivider).not.toBeNull();
    expect(fields).not.toBeNull();
    expect(bodyFrame?.className).toContain("px-4");
    expect(bodyFrame?.className).toContain("sm:px-5");
    expect(scrollArea?.className).toContain("dev-render-scroll");
    expect(footer?.className).toContain("sm:px-5");
    expect(footer?.className).toContain("pt-0");
    expect(fields?.className).not.toContain("pb-");
    expect(divider?.className).toContain("border-t");
    expect(divider?.className).toContain("mr-4");
    expect(footerDivider?.className).toContain("border-t");
    expect(footerDivider?.className).toContain("mr-4");
  });

  it("keeps detail-free Voice Pilot choices compact", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));

    const choiceTriggers = document.querySelectorAll<HTMLElement>(
      '[data-slot="voice-settings-choice-trigger"]',
    );
    expect(choiceTriggers.length).toBeGreaterThan(0);
    expect(choiceTriggers[0]?.className).toContain("min-h-11");
    expect(choiceTriggers[0]?.className).not.toContain("min-h-[60px]");
    expect(
      Array.from(choiceTriggers).some((trigger) => trigger.className.includes("min-h-[60px]")),
    );
  });

  it("keeps save feedback visible long enough to read", async () => {
    const onOpenChange = vi.fn();
    render(<SettingsDialog open onOpenChange={onOpenChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestVoiceCapabilities).toHaveBeenCalledWith({ region: "cn" }));

    vi.useFakeTimers();
    try {
      const saveButton = screen.getByRole("button", { name: "保存" });
      fireEvent.click(saveButton);

      expect(updateVoiceConfig).toHaveBeenCalledTimes(1);
      expect(screen.getAllByText("保存中...").length).toBeGreaterThan(0);
      expect(saveButton).toHaveProperty("disabled", true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(screen.getByText("已保存")).not.toBeNull();
      expect(saveButton).toHaveProperty("disabled", false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1200);
      });
      expect(screen.getByText("已保存")).not.toBeNull();
      expect(saveButton).toHaveProperty("disabled", false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(screen.queryByText("已保存")).toBeNull();
      expect(saveButton).toHaveProperty("disabled", false);
      expect(onOpenChange).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tests TTS and STT with current form values, plays the returned audio, and blocks saving while playing", async () => {
    testVoiceConfig.mockResolvedValueOnce({
      success: true,
      audioBase64: "AQI=",
      audioSampleRate: 16000,
      audioEncoding: "pcm_s16le",
      transcript: "语音助手测试",
    });
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestVoiceCapabilities).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText("阿里云百炼 API Key"), {
      target: { value: "sk-test" },
    });
    chooseVoiceSetting("语音音色", "龙安朗 · 男 · 动态清爽 · 年龄 20-25");
    const testButton = screen.getByRole("button", { name: "测试" });
    expect(testButton.querySelector("svg")).not.toBeNull();
    fireEvent.click(testButton);

    await waitFor(() => {
      expect(testVoiceConfig).toHaveBeenCalledWith({
        apiKey: "sk-test",
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime-live",
        ttsModel: "cosyvoice-v3-flash-live",
        ttsVoice: "longanlang-live",
        turnIdleSeconds: 3,
      });
    });
    expect(playerEnqueue).toHaveBeenCalledWith(new Uint8Array([1, 2]));
    expect(await screen.findByText("正在播放测试音频")).not.toBeNull();
    expect(testButton).toHaveProperty("disabled", true);
    const saveButton = screen.getByRole("button", { name: "保存" });
    expect(saveButton).toHaveProperty("disabled", true);
    fireEvent.click(saveButton);
    expect(updateVoiceConfig).not.toHaveBeenCalled();
    expect(await screen.findByText("测试通过")).not.toBeNull();
    await waitFor(() => expect(testButton).toHaveProperty("disabled", false));
  });

  it("shows masked API key state and can clear the saved key", async () => {
    requestVoiceConfig.mockResolvedValueOnce({
      config: {
        provider: "aliyun-bailian",
        configured: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime-live",
        ttsModel: "cosyvoice-v3-flash-live",
        ttsVoice: "longanhuan-live",
        turnIdleSeconds: 3,
      },
    });
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestVoiceCapabilities).toHaveBeenCalledTimes(1));

    expect(screen.getByPlaceholderText("••••••••••••••••")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.getByText("保存后会清空已保存的 key")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(updateVoiceConfig).toHaveBeenCalledWith({
        clearApiKey: true,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime-live",
        ttsModel: "cosyvoice-v3-flash-live",
        ttsVoice: "longanhuan-live",
        turnIdleSeconds: 3,
      });
    });
  });

  it("renders voice provider choices from relay capabilities instead of local option tables", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestVoiceCapabilities).toHaveBeenCalledTimes(1));

    expect(document.querySelector("select")).toBeNull();
    expect(screen.getByRole("button", { name: "语音识别模型" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "语音合成模型" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "语音音色" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "语音合成模型" }));
    expect(screen.getByRole("option", { name: "CosyVoice V3 Flash · 动态" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "语音音色" }));
    expect(
      screen.getByRole("option", { name: "龙安欢 · 女 · 动态元气 · 年龄 20-30" }),
    ).not.toBeNull();
    expect(screen.queryByRole("option", { name: "CosyVoice V3 Flash · 快速合成" })).toBeNull();
  });

  it("prevents selecting TTS models that have no compatible voice", async () => {
    requestVoiceConfig.mockResolvedValueOnce({
      config: {
        provider: "aliyun-bailian",
        configured: false,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime-live",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanhuan",
        turnIdleSeconds: 3,
      },
    });
    requestVoiceCapabilities.mockResolvedValueOnce({
      capabilities: {
        asrModels: [
          {
            value: "qwen3-asr-flash-realtime-live",
            label: "Qwen3 ASR · 动态实时",
            source: "official",
          },
        ],
        ttsModels: [
          {
            value: "cosyvoice-v3-flash",
            label: "CosyVoice V3 Flash · 系统音色",
            source: "official",
          },
          {
            value: "cosyvoice-v3.5-plus",
            label: "CosyVoice V3.5 Plus · 自定义音色",
            source: "official",
          },
        ],
        ttsVoices: [
          {
            value: "longanhuan",
            label: "龙安欢 · 女 · 欢脱元气 · 20-30",
            gender: "female",
            age: "20-30",
            model: "cosyvoice-v3-flash",
            source: "official",
          },
        ],
        fetchedAt: 1760000000000,
      },
    });
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));
    await waitFor(() => expect(requestVoiceCapabilities).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "语音合成模型" }));
    const unsupportedModel = screen.getByRole("option", {
      name: "CosyVoice V3.5 Plus · 自定义音色 · 暂无音色",
    });
    expect(unsupportedModel).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "保存" })).toHaveProperty("disabled", false);
  });

  it("falls back to bundled voice choices when relay capabilities time out", async () => {
    requestVoiceConfig.mockResolvedValueOnce({
      config: {
        provider: "aliyun-bailian",
        configured: false,
        region: "cn",
        asrModel: "qwen3-asr-flash-realtime",
        ttsModel: "cosyvoice-v3-flash",
        ttsVoice: "longanyang",
        turnIdleSeconds: 3,
      },
    });
    requestVoiceCapabilities.mockRejectedValueOnce(new Error("读取语音能力列表超时"));

    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestVoiceCapabilities).toHaveBeenCalledTimes(1));

    expect(screen.getByText("Qwen3 ASR Flash Realtime")).not.toBeNull();
    expect(screen.getByText("CosyVoice V3 Flash")).not.toBeNull();
    expect(screen.getByText("龙安洋")).not.toBeNull();
    expect(screen.queryByText("读取语音能力列表超时")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "语音识别模型" }));
    expect(screen.getByRole("option", { name: "Qwen3 ASR Flash Realtime" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "语音合成模型" }));
    expect(screen.getByRole("option", { name: "CosyVoice V3 Flash · 系统音色" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "语音音色" }));
    expect(
      screen.getByRole("option", { name: "龙安洋 · 男 · 阳光大男孩 · 年龄 20-30" }),
    ).not.toBeNull();
  });

  it("keeps save success visible when the post-save capability refresh times out", async () => {
    requestVoiceCapabilities
      .mockResolvedValueOnce({
        capabilities: {
          asrModels: [
            {
              value: "qwen3-asr-flash-realtime-live",
              label: "Qwen3 ASR · 动态实时",
              source: "official",
            },
          ],
          ttsModels: [
            {
              value: "cosyvoice-v3-flash-live",
              label: "CosyVoice V3 Flash · 动态",
              source: "official",
            },
          ],
          ttsVoices: [
            {
              value: "longanhuan-live",
              label: "龙安欢 · 女 · 动态元气 · 20-30",
              gender: "female",
              age: "20-30",
              model: "cosyvoice-v3-flash-live",
              source: "official",
            },
          ],
          fetchedAt: 1760000000000,
        },
      })
      .mockRejectedValueOnce(new Error("读取语音能力列表超时"));

    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestVoiceCapabilities).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(updateVoiceConfig).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("已保存")).not.toBeNull();
    expect(screen.queryByText("保存语音设置失败")).toBeNull();
  });
});
