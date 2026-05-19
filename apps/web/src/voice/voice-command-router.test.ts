import { describe, expect, it } from "vitest";
import { routeVoiceText } from "./voice-command-router";

describe("routeVoiceText", () => {
  it("routes explicit exit commands", () => {
    expect(routeVoiceText("退出语音助手", { phase: "listening" })).toEqual({
      kind: "command",
      command: { type: "exit" },
    });
  });

  it("routes repeat, cancel, and redo commands", () => {
    expect(routeVoiceText("复述", { phase: "listening" })).toEqual({
      kind: "command",
      command: { type: "repeat" },
    });
    expect(routeVoiceText("取消", { phase: "drafting" })).toEqual({
      kind: "command",
      command: { type: "cancel" },
    });
    expect(routeVoiceText("重说", { phase: "drafting" })).toEqual({
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
