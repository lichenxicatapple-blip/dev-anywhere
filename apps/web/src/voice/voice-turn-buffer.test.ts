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
});
