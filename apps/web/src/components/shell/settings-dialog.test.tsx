import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  playerEnqueue,
  playerStop,
  kickRelayClient,
  requestRelayClients,
  requestVoiceCapabilities,
  requestVoiceConfig,
  reconnectRelayClient,
  testVoiceConfig,
  updateVoiceConfig,
} = vi.hoisted(() => ({
  playerEnqueue: vi.fn(),
  playerStop: vi.fn(),
  kickRelayClient: vi.fn(),
  requestRelayClients: vi.fn(),
  requestVoiceCapabilities: vi.fn(),
  requestVoiceConfig: vi.fn(),
  reconnectRelayClient: vi.fn(),
  testVoiceConfig: vi.fn(),
  updateVoiceConfig: vi.fn(),
}));

vi.mock("@/hooks/use-relay-setup", () => ({
  relayClientRef: {
    kickRelayClient,
    requestRelayClients,
    requestVoiceCapabilities,
    requestVoiceConfig,
    testVoiceConfig,
    updateVoiceConfig,
  },
  reconnectRelayClient,
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
    document.documentElement.removeAttribute("data-theme");
    document.querySelector('meta[name="color-scheme"]')?.remove();
    const colorSchemeMeta = document.createElement("meta");
    colorSchemeMeta.setAttribute("name", "color-scheme");
    colorSchemeMeta.setAttribute("content", "light");
    document.head.append(colorSchemeMeta);
    useAppStore.setState({
      inputModePreference: "auto",
      latencyMonitorEnabled: false,
      proxies: [{ proxyId: "proxy-1", name: "Work Mac", online: true }],
      proxyListLoaded: true,
      ptyScrollTraceEnabled: false,
      themePreference: "auto",
    });
    playerEnqueue.mockReset();
    playerStop.mockReset();
    requestRelayClients.mockReset();
    requestRelayClients.mockResolvedValue([
      {
        clientId: "current-client",
        connectedAt: Date.now() - 60_000,
        current: true,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
        browserName: "Safari",
        osName: "iPad",
        deviceKind: "tablet",
        remoteAddress: "127.0.0.1",
      },
      {
        clientId: "other-client",
        proxyId: "proxy-1",
        connectedAt: Date.now() - 120_000,
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15",
        browserName: "Safari",
        osName: "iPad",
        deviceKind: "tablet",
        remoteAddress: "192.168.1.23",
      },
    ]);
    kickRelayClient.mockReset();
    kickRelayClient.mockResolvedValue({ clientId: "other-client", success: true });
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
    reconnectRelayClient.mockReset();
    reconnectRelayClient.mockResolvedValue(undefined);
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
    expect(screen.getByRole("radiogroup", { name: "输入方式" })).not.toBeNull();
    expect(screen.getByText("默认自动识别软键盘和实体键盘；必要时可强制一种方式")).not.toBeNull();
    expect(screen.getByRole("radiogroup", { name: "主题" })).not.toBeNull();
    expect(screen.getByRole("radio", { name: "跟随系统" })).not.toBeNull();
    expect(screen.queryByText(/固定为浅色或深色/)).toBeNull();
    expect(screen.getByRole("switch", { name: "PTY 滚动追踪" })).not.toBeNull();
    expect(screen.getByText("记录终端滚动和视口同步现场，方便复制诊断报告")).not.toBeNull();
    const scrollArea = document.querySelector<HTMLElement>('[data-slot="settings-dialog-body"]');
    expect(scrollArea?.className).toContain("pr-4");
    expect(scrollArea?.className).toContain("sm:pr-1");
    const menuItems = screen.getAllByRole("button").filter((button) => {
      return button.getAttribute("data-slot") === "settings-menu-item";
    });
    expect(menuItems.map((item) => item.textContent)).toEqual([
      "Voice Pilot用语音输入、听取回复和处理审批",
      "Relay Token未设置 · 受保护的 Relay 服务器",
      "客户端管理已连接的浏览器页面和设备",
      "版本",
    ]);
  });

  it("keeps settings subview headers left-aligned consistently", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    for (const label of ["Relay Token", "客户端管理", "版本", "Voice Pilot"]) {
      fireEvent.click(screen.getByRole("button", { name: label }));

      const header = document.querySelector<HTMLElement>('[data-slot="dialog-header"]');
      const description = document.querySelector<HTMLElement>('[data-slot="dialog-description"]');
      const heading = label === "Voice Pilot" ? "设置 Voice Pilot" : label;
      expect(screen.getByRole("heading", { name: heading })).not.toBeNull();
      expect(header?.className).toContain("text-left");
      expect(description?.className).toContain("max-w-[28rem]");
      expect(description?.className).toContain("leading-5");
      const body = document.querySelector<HTMLElement>('[data-slot="settings-dialog-body"]');
      if (label !== "Voice Pilot") {
        expect(body?.className).toContain("space-y-3");
        expect(body?.className).toContain("pr-4");
        expect(body?.className).toContain("sm:pr-1");
      }

      fireEvent.click(screen.getByRole("button", { name: "返回设置" }));
    }
  });

  it("lists connected relay clients and can disconnect another client", async () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "客户端管理" }));

    expect(await screen.findByRole("heading", { name: "客户端管理" })).not.toBeNull();
    await waitFor(() => expect(requestRelayClients).toHaveBeenCalledTimes(1));
    expect(screen.getByText("2 个在线客户端")).not.toBeNull();
    expect(screen.getByRole("button", { name: "刷新客户端列表" })).not.toBeNull();
    expect(screen.getByText("当前设备")).not.toBeNull();
    expect(document.querySelector('[data-client-id="current-client"]')).not.toBeNull();
    expect(document.querySelector('[data-client-id="other-client"]')).not.toBeNull();
    expect(screen.getAllByText("Safari · iPad")).toHaveLength(2);
    expect(screen.getByText("连接到")).not.toBeNull();
    expect(screen.getByText("Work Mac")).not.toBeNull();
    expect(screen.queryByText("连接到 Work Mac")).toBeNull();

    const buttons = screen.getAllByRole("button", { name: "断开" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);

    await waitFor(() => expect(kickRelayClient).toHaveBeenCalledWith("other-client"));
    await waitFor(() =>
      expect(document.querySelector('[data-client-id="other-client"]')).toBeNull(),
    );
    expect(document.querySelector('[data-client-id="current-client"]')).not.toBeNull();
  });

  it("persists theme preference while keeping auto as the default", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    const auto = screen.getByRole("radio", { name: "跟随系统" });
    const light = screen.getByRole("radio", { name: "浅色" });
    const dark = screen.getByRole("radio", { name: "深色" });
    expect(auto.getAttribute("aria-checked")).toBe("true");
    expect(auto.className).toContain("whitespace-nowrap");
    expect(localStorage.getItem("dev_anywhere_theme")).toBeNull();

    fireEvent.click(dark);

    expect(useAppStore.getState().themePreference).toBe("dark");
    expect(localStorage.getItem("dev_anywhere_theme")).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
      "dark",
    );
    expect(dark.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(light);

    expect(useAppStore.getState().themePreference).toBe("light");
    expect(localStorage.getItem("dev_anywhere_theme")).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
      "light",
    );
    expect(light.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(auto);

    expect(useAppStore.getState().themePreference).toBe("auto");
    expect(localStorage.getItem("dev_anywhere_theme")).toBeNull();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe(
      "light",
    );
    expect(auto.getAttribute("aria-checked")).toBe("true");
  });

  it("persists input mode preference from global settings", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    const auto = screen.getByRole("radio", { name: "自动" });
    const touch = screen.getByRole("radio", { name: "触控优先" });
    const hardware = screen.getByRole("radio", { name: "实体键盘优先" });
    expect(auto.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(hardware);

    expect(useAppStore.getState().inputModePreference).toBe("hardware");
    expect(localStorage.getItem("dev_anywhere_inputModePreference")).toBe("hardware");
    expect(hardware.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(touch);

    expect(useAppStore.getState().inputModePreference).toBe("touch");
    expect(localStorage.getItem("dev_anywhere_inputModePreference")).toBe("touch");
    expect(touch.getAttribute("aria-checked")).toBe("true");
  });

  it("persists PTY scroll trace from global settings", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    const toggle = screen.getByRole("switch", { name: "PTY 滚动追踪" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(useAppStore.getState().ptyScrollTraceEnabled).toBe(true);
    expect(localStorage.getItem("dev_anywhere_pty_scroll_trace")).toBe("1");
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);

    expect(useAppStore.getState().ptyScrollTraceEnabled).toBe(false);
    expect(localStorage.getItem("dev_anywhere_pty_scroll_trace")).toBe("0");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("saves relay client token from settings and reconnects without reloading", () => {
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Relay Token" }));
    expect(screen.queryByText("未保存")).toBeNull();
    fireEvent.change(screen.getByLabelText("Token"), {
      target: { value: " client-secret " },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(localStorage.getItem("dev_anywhere_relayClientToken")).toBe("client-secret");
    expect(sessionStorage.getItem("dev_anywhere_relayClientToken")).toBe("client-secret");
    expect(reconnectRelayClient).toHaveBeenCalledTimes(1);
  });

  it("shows saved relay client token state and can clear it from settings", () => {
    localStorage.setItem("dev_anywhere_relayClientToken", "old-token");
    sessionStorage.setItem("dev_anywhere_relayClientToken", "old-token");
    render(<SettingsDialog open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Relay Token" }).textContent).toContain("已保存");
    fireEvent.click(screen.getByRole("button", { name: "Relay Token" }));
    expect(document.querySelector('[data-slot="relay-token-card"]')).not.toBeNull();
    expect(screen.queryByText("已保存 token")).toBeNull();
    expect(screen.queryByText("未保存")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "清空" }));

    expect(localStorage.getItem("dev_anywhere_relayClientToken")).toBeNull();
    expect(sessionStorage.getItem("dev_anywhere_relayClientToken")).toBeNull();
    expect(reconnectRelayClient).toHaveBeenCalledTimes(1);
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
    expect(scrollArea?.className).toContain("pr-4");
    expect(scrollArea?.className).toContain("sm:pr-1");
    expect(footer?.className).toContain("sm:px-5");
    expect(footer?.className).toContain("pt-0");
    expect(fields?.className).not.toContain("pb-");
    expect(divider?.className).toContain("border-t");
    expect(divider?.className).toContain("mr-4");
    expect(footerDivider?.className).toContain("border-t");
    expect(footerDivider?.className).toContain("mr-4");
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
