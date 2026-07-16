import { describe, expect, it } from "vitest";
import { parseVoiceCommand } from "./voice-command";

describe("parseVoiceCommand", () => {
  it("parses exact local commands", () => {
    expect(parseVoiceCommand("复述")).toEqual({ type: "repeat" });
    expect(parseVoiceCommand("再说一遍")).toEqual({ type: "repeat" });
    expect(parseVoiceCommand("暂停")).toEqual({ type: "pause" });
    expect(parseVoiceCommand("继续")).toBeNull();
    expect(parseVoiceCommand("取消")).toEqual({ type: "cancel" });
    expect(parseVoiceCommand("状态")).toEqual({ type: "status" });
    expect(parseVoiceCommand("退出语音助手")).toEqual({ type: "exit" });
    expect(parseVoiceCommand("关闭语音助手")).toEqual({ type: "exit" });
    expect(parseVoiceCommand("停止语音助手")).toEqual({ type: "exit" });
    expect(parseVoiceCommand("嗯关闭语音助手吧")).toEqual({ type: "exit" });
    expect(parseVoiceCommand("退出 VoicePilot")).toEqual({ type: "exit" });
  });

  it("requires explicit approval and denial phrases", () => {
    expect(parseVoiceCommand("允许")).toEqual({ type: "approve_once" });
    expect(parseVoiceCommand("始终允许")).toEqual({ type: "approve_always" });
    expect(parseVoiceCommand("批准")).toBeNull();
    expect(parseVoiceCommand("拒绝")).toEqual({ type: "deny_once" });
    expect(parseVoiceCommand("批准这次")).toBeNull();
    expect(parseVoiceCommand("拒绝这次")).toBeNull();
    expect(parseVoiceCommand("好")).toBeNull();
    expect(parseVoiceCommand("嗯")).toBeNull();
    expect(parseVoiceCommand("可以")).toBeNull();
  });

  it("treats normal utterances as non-command input", () => {
    expect(parseVoiceCommand("帮我检查测试失败原因")).toBeNull();
    expect(parseVoiceCommand("批准这次吧")).toBeNull();
  });
});
