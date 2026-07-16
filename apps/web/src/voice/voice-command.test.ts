import { describe, expect, it } from "vitest";
import { parseVoiceCommand } from "./voice-command";

describe("parseVoiceCommand", () => {
  it("parses exact local commands", () => {
    expect(parseVoiceCommand("复述")).toEqual({ type: "repeat" });
    expect(parseVoiceCommand("再说一遍")).toEqual({ type: "repeat" });
    expect(parseVoiceCommand("暂停")).toBeNull();
    expect(parseVoiceCommand("继续")).toBeNull();
    expect(parseVoiceCommand("取消")).toBeNull();
    expect(parseVoiceCommand("重说")).toBeNull();
    expect(parseVoiceCommand("状态")).toBeNull();
    expect(parseVoiceCommand("退出语音助手")).toEqual({ type: "exit" });
    expect(parseVoiceCommand("关闭语音助手")).toEqual({ type: "exit" });
    expect(parseVoiceCommand("停止语音助手")).toEqual({ type: "exit" });
    expect(parseVoiceCommand("嗯关闭语音助手吧")).toEqual({ type: "exit" });
    expect(parseVoiceCommand("退出 VoicePilot")).toEqual({ type: "exit" });
  });

  it("accepts natural approval and denial phrases", () => {
    expect(parseVoiceCommand("允许")).toEqual({ type: "approve_once" });
    expect(parseVoiceCommand("始终允许")).toEqual({ type: "approve_always" });
    expect(parseVoiceCommand("我同意！")).toEqual({ type: "approve_once" });
    expect(parseVoiceCommand("我不同意。")).toEqual({ type: "deny_once" });
    expect(parseVoiceCommand("批准")).toBeNull();
    expect(parseVoiceCommand("拒绝")).toEqual({ type: "deny_once" });
    expect(parseVoiceCommand("批准这次")).toBeNull();
    expect(parseVoiceCommand("拒绝这次")).toEqual({ type: "deny_once" });
    expect(parseVoiceCommand("好")).toBeNull();
    expect(parseVoiceCommand("嗯")).toBeNull();
    expect(parseVoiceCommand("可以")).toBeNull();
  });

  it("treats normal utterances as non-command input", () => {
    expect(parseVoiceCommand("帮我检查测试失败原因")).toBeNull();
    expect(parseVoiceCommand("批准这次吧")).toBeNull();
  });
});
