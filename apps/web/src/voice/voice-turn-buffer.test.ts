import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceTurnBuffer } from "./voice-turn-buffer";

describe("VoiceTurnBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers an ASR final and emits a turn only after the idle timeout", () => {
    const onTurnReady = vi.fn();
    const buffer = new VoiceTurnBuffer({ idleTimeoutMs: 3000, onTurnReady });

    buffer.appendFinal("帮我看一下报错");

    expect(onTurnReady).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2999);
    expect(onTurnReady).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTurnReady).toHaveBeenCalledTimes(1);
    expect(onTurnReady).toHaveBeenCalledWith("帮我看一下报错");
  });

  it("submits short utterances such as 嗯 as normal text", () => {
    const onTurnReady = vi.fn();
    const buffer = new VoiceTurnBuffer({ idleTimeoutMs: 3000, onTurnReady });

    buffer.appendFinal("嗯。");
    vi.advanceTimersByTime(3000);

    expect(onTurnReady).toHaveBeenCalledWith("嗯。");
  });

  it("joins multiple final segments into one voice turn", () => {
    const onTurnReady = vi.fn();
    const buffer = new VoiceTurnBuffer({ idleTimeoutMs: 3000, onTurnReady });

    buffer.appendFinal("帮我看一下这个报错");
    vi.advanceTimersByTime(1500);
    buffer.appendFinal("我怀疑是滚动同步的问题");
    vi.advanceTimersByTime(2999);

    expect(onTurnReady).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTurnReady).toHaveBeenCalledWith("帮我看一下这个报错\n我怀疑是滚动同步的问题");
  });

  it("does not submit an earlier final while a later partial is still active", () => {
    const onTurnReady = vi.fn();
    const buffer = new VoiceTurnBuffer({ idleTimeoutMs: 3000, onTurnReady });

    buffer.appendFinal("嗯。");
    vi.advanceTimersByTime(2500);
    buffer.appendPartial("我最近在忙着写一个操作系统。");
    vi.advanceTimersByTime(500);

    expect(onTurnReady).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2499);
    expect(onTurnReady).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTurnReady).toHaveBeenCalledTimes(1);
    expect(onTurnReady).toHaveBeenCalledWith("嗯。\n我最近在忙着写一个操作系统。");
  });

  it("uses the latest partial as a turn when ASR does not provide a final segment", () => {
    const onTurnReady = vi.fn();
    const buffer = new VoiceTurnBuffer({ idleTimeoutMs: 3000, onTurnReady });

    buffer.appendPartial("我最近在忙着写一个操作系统。");
    vi.advanceTimersByTime(2999);

    expect(onTurnReady).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTurnReady).toHaveBeenCalledWith("我最近在忙着写一个操作系统。");
  });

  it("does not submit empty or whitespace-only final text", () => {
    const onTurnReady = vi.fn();
    const buffer = new VoiceTurnBuffer({ idleTimeoutMs: 3000, onTurnReady });

    buffer.appendFinal("   ");
    vi.advanceTimersByTime(3000);

    expect(onTurnReady).not.toHaveBeenCalled();
    expect(buffer.getSnapshot()).toMatchObject({ draft: "", hasDraft: false });
  });

  it("cancels the pending draft", () => {
    const onTurnReady = vi.fn();
    const buffer = new VoiceTurnBuffer({ idleTimeoutMs: 3000, onTurnReady });

    buffer.appendFinal("这句话不要发");
    buffer.cancel();
    vi.advanceTimersByTime(3000);

    expect(onTurnReady).not.toHaveBeenCalled();
    expect(buffer.getSnapshot()).toMatchObject({ draft: "", hasDraft: false });
  });

  it("reports whether an immediate flush preserved recognized text", () => {
    const onTurnReady = vi.fn();
    const buffer = new VoiceTurnBuffer({ idleTimeoutMs: 3000, onTurnReady });

    expect(buffer.flushNow()).toBe(false);
    buffer.appendPartial("连接断开前已识别的内容");
    expect(buffer.flushNow()).toBe(true);
    expect(onTurnReady).toHaveBeenCalledWith("连接断开前已识别的内容");
    expect(buffer.flushNow()).toBe(false);
  });
});
