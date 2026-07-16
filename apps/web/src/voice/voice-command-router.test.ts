import { describe, expect, it } from "vitest";
import { routeVoiceText } from "./voice-command-router";

describe("routeVoiceText", () => {
  it("routes exit phrases even when ASR adds surrounding speech", () => {
    expect(routeVoiceText("退出语音助手", { phase: "listening" })).toEqual({
      kind: "command",
      command: { type: "exit" },
    });
    expect(routeVoiceText("嗯，帮我关闭语音助手吧。", { phase: "listening" })).toEqual({
      kind: "command",
      command: { type: "exit" },
    });
    expect(routeVoiceText("有一点杂音停止语音助手谢谢", { phase: "listening" })).toEqual({
      kind: "command",
      command: { type: "exit" },
    });
    for (const text of ["退出 VoicePilot", "请关闭 voice pilot 吧", "停止 VOICE PILOT 谢谢"]) {
      expect(routeVoiceText(text, { phase: "listening" })).toEqual({
        kind: "command",
        command: { type: "exit" },
      });
    }
  });

  it("routes repeat, cancel, and redo commands", () => {
    expect(routeVoiceText("复述", { phase: "listening" })).toEqual({
      kind: "command",
      command: { type: "repeat" },
    });
    expect(routeVoiceText("取消", { phase: "listening" })).toEqual({
      kind: "command",
      command: { type: "cancel" },
    });
    expect(routeVoiceText("重说", { phase: "listening" })).toEqual({
      kind: "command",
      command: { type: "redo" },
    });
  });

  it("does not treat ordinary short text as a command", () => {
    expect(routeVoiceText("嗯。", { phase: "listening" })).toEqual({
      kind: "agentText",
      text: "嗯。",
    });
    expect(routeVoiceText("好", { phase: "listening" })).toEqual({
      kind: "agentText",
      text: "好",
    });
    expect(routeVoiceText("可以", { phase: "listening" })).toEqual({
      kind: "agentText",
      text: "可以",
    });
    expect(routeVoiceText("允许", { phase: "listening" })).toEqual({
      kind: "agentText",
      text: "允许",
    });
    expect(routeVoiceText("批准", { phase: "listening" })).toEqual({
      kind: "agentText",
      text: "批准",
    });
  });

  it("routes short approval commands only while an approval prompt is active", () => {
    expect(routeVoiceText("允许。", { phase: "approval", approvalPromptActive: true })).toEqual({
      kind: "command",
      command: { type: "approve_once" },
    });
    expect(routeVoiceText("始终允许。", { phase: "approval", approvalPromptActive: true })).toEqual(
      {
        kind: "command",
        command: { type: "approve_always" },
      },
    );
    expect(routeVoiceText("批准。", { phase: "approval", approvalPromptActive: true })).toEqual({
      kind: "agentText",
      text: "批准。",
    });
    expect(routeVoiceText("拒绝", { phase: "approval", approvalPromptActive: true })).toEqual({
      kind: "command",
      command: { type: "deny_once" },
    });
    expect(routeVoiceText("批准这次", { phase: "approval" })).toEqual({
      kind: "agentText",
      text: "批准这次",
    });
    expect(routeVoiceText("批准这次", { phase: "approval", approvalPromptActive: true })).toEqual({
      kind: "agentText",
      text: "批准这次",
    });
    expect(routeVoiceText("始终允许", { phase: "listening" })).toEqual({
      kind: "agentText",
      text: "始终允许",
    });
  });

  it("uses the final short clause for active approval prompts", () => {
    expect(routeVoiceText("嗯。允许。", { phase: "approval", approvalPromptActive: true })).toEqual(
      {
        kind: "command",
        command: { type: "approve_once" },
      },
    );
    expect(
      routeVoiceText("好的，始终允许。", { phase: "approval", approvalPromptActive: true }),
    ).toEqual({
      kind: "command",
      command: { type: "approve_always" },
    });
    expect(
      routeVoiceText("好的，拒绝。", { phase: "approval", approvalPromptActive: true }),
    ).toEqual({
      kind: "command",
      command: { type: "deny_once" },
    });
    expect(routeVoiceText("嗯。批准。", { phase: "listening" })).toEqual({
      kind: "agentText",
      text: "嗯。批准。",
    });
    expect(routeVoiceText("我批准。", { phase: "approval", approvalPromptActive: true })).toEqual({
      kind: "agentText",
      text: "我批准。",
    });
    expect(routeVoiceText("批准这个。", { phase: "approval", approvalPromptActive: true })).toEqual(
      {
        kind: "agentText",
        text: "批准这个。",
      },
    );
  });

  it("only treats 继续 as resume while paused", () => {
    expect(routeVoiceText("继续", { phase: "paused" })).toEqual({
      kind: "command",
      command: { type: "resume" },
    });
    expect(routeVoiceText("继续", { phase: "listening" })).toEqual({
      kind: "agentText",
      text: "继续",
    });
  });
});
