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

describe("SettingsDialog", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  beforeEach(() => {
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

  it("shows the Voice Pilot settings entry without a subtitle", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "设置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /版本/ })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Voice Pilot" })).not.toBeNull();
    const menuItems = screen.getAllByRole("button").filter((button) => {
      return button.getAttribute("data-slot") === "settings-menu-item";
    });
    expect(menuItems.map((item) => item.textContent)).toEqual(["Voice Pilot", "版本"]);
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
    fireEvent.change(screen.getByLabelText("语音音色"), {
      target: { value: "longanlang-live" },
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
      });
    });
    expect(await screen.findByText("已保存")).not.toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();
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
    fireEvent.change(screen.getByLabelText("语音音色"), {
      target: { value: "longanlang-live" },
    });
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
      });
    });
  });

  it("renders voice provider choices from relay capabilities instead of local option tables", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestVoiceCapabilities).toHaveBeenCalledTimes(1));

    expect(screen.getByLabelText("语音识别模型").tagName).toBe("SELECT");
    expect(screen.getByLabelText("语音合成模型").tagName).toBe("SELECT");
    expect(screen.getByLabelText("语音音色").tagName).toBe("SELECT");
    expect(screen.getByRole("option", { name: "CosyVoice V3 Flash · 动态" })).not.toBeNull();
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
      },
    });
    requestVoiceCapabilities.mockRejectedValueOnce(new Error("读取语音能力列表超时"));

    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Voice Pilot" }));
    await waitFor(() => expect(requestVoiceConfig).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(requestVoiceCapabilities).toHaveBeenCalledTimes(1));

    expect((screen.getByLabelText("语音识别模型") as HTMLSelectElement).value).toBe(
      "qwen3-asr-flash-realtime",
    );
    expect((screen.getByLabelText("语音合成模型") as HTMLSelectElement).value).toBe(
      "cosyvoice-v3-flash",
    );
    expect((screen.getByLabelText("语音音色") as HTMLSelectElement).value).toBe("longanyang");
    expect(screen.queryByText("读取语音能力列表超时")).toBeNull();
    expect(screen.getByRole("option", { name: "Qwen3 ASR Flash Realtime" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "CosyVoice V3 Flash · 系统音色" })).not.toBeNull();
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
