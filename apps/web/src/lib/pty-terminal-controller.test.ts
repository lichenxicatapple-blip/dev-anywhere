import { afterEach, describe, expect, it, vi } from "vitest";
import { attachPtyTerminalController } from "./pty-terminal-controller";

function createTerminal() {
  return {
    onData: vi.fn(),
    focus: vi.fn(),
    reset: vi.fn(),
    resize: vi.fn(),
    write: vi.fn(),
  };
}

function createHarness() {
  const terminal = createTerminal();
  const disposeTerminal = vi.fn();
  const disposeRawInput = vi.fn();
  const disposeTransport = vi.fn();
  const flushOutput = vi.fn();
  const setOutputPaused = vi.fn();
  const host = document.createElement("div") as HTMLDivElement;
  return {
    host,
    terminal,
    disposeTerminal,
    disposeRawInput,
    disposeTransport,
    ws: {
      send: vi.fn(() => true),
      subscribeBinary: vi.fn(() => vi.fn()),
    },
    relay: {
      onMessage: vi.fn(() => vi.fn()),
    },
    createTerminal: vi.fn(async () => ({ terminal, dispose: disposeTerminal })),
    attachRawInput: vi.fn(() => ({ dispose: disposeRawInput })),
    attachTransport: vi.fn(() => ({ dispose: disposeTransport, flushOutput, setOutputPaused })),
    flushOutput,
    setOutputPaused,
  };
}

describe("attachPtyTerminalController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates xterm, attaches raw input, focus handler, and transport", async () => {
    const h = createHarness();
    const onTerminalReady = vi.fn();
    const onReady = vi.fn();
    const onSubscribeDelayed = vi.fn();

    attachPtyTerminalController({
      host: h.host,
      sessionId: "s1",
      ws: h.ws,
      relay: h.relay,
      createTerminal: h.createTerminal,
      attachRawInput: h.attachRawInput,
      attachTransport: h.attachTransport,
      onTerminalReady,
      onReady,
      onSubscribeDelayed,
    });
    await Promise.resolve();

    expect(h.createTerminal).toHaveBeenCalledWith(h.host);
    expect(h.attachRawInput).toHaveBeenCalledWith(h.terminal, "s1", {
      onRawInput: undefined,
    });
    expect(onTerminalReady).toHaveBeenCalledWith(h.terminal);
    expect(h.attachTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        ws: h.ws,
        relay: h.relay,
        target: h.terminal,
        onReady,
        onSubscribeDelayed,
      }),
    );

    h.host.dispatchEvent(new Event("pointerdown"));
    expect(h.terminal.focus).toHaveBeenCalledTimes(1);
  });

  it("focuses the terminal once it is ready so keyboard input works after navigation", async () => {
    vi.useFakeTimers();
    const h = createHarness();

    attachPtyTerminalController({
      host: h.host,
      sessionId: "s1",
      ws: h.ws,
      relay: h.relay,
      createTerminal: h.createTerminal,
      attachRawInput: h.attachRawInput,
      attachTransport: h.attachTransport,
    });
    await Promise.resolve();

    expect(h.terminal.focus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(16);

    expect(h.terminal.focus).toHaveBeenCalledTimes(1);
  });

  // 触屏入口要传 noop scheduleAutoFocus, 不让进会话立刻给 helper textarea 抛 focus
  // (Android Chrome / iOS Safari 看到 focus 立刻起 IME, 视口被键盘吃掉一半)。
  it("skips auto-focus when scheduleAutoFocus is a no-op (touch device opt-out)", async () => {
    const h = createHarness();
    const noop = vi.fn();

    attachPtyTerminalController({
      host: h.host,
      sessionId: "s1",
      ws: h.ws,
      relay: h.relay,
      createTerminal: h.createTerminal,
      attachRawInput: h.attachRawInput,
      attachTransport: h.attachTransport,
      scheduleAutoFocus: noop,
    });
    await Promise.resolve();
    await Promise.resolve();

    // 即便注入的 schedule 立即被调过, 它不再调回调函数, focus 永远不发生。
    expect(noop).toHaveBeenCalledTimes(1);
    expect(h.terminal.focus).not.toHaveBeenCalled();

    // 用户主动点 PTY (pointerdown) 仍然要拿到 focus, 这条手动入口不能被这次改动破坏。
    h.host.dispatchEvent(new Event("pointerdown"));
    expect(h.terminal.focus).toHaveBeenCalledTimes(1);
  });

  it("does not auto-focus after disposal", async () => {
    vi.useFakeTimers();
    const h = createHarness();

    const controller = attachPtyTerminalController({
      host: h.host,
      sessionId: "s1",
      ws: h.ws,
      relay: h.relay,
      createTerminal: h.createTerminal,
      attachRawInput: h.attachRawInput,
      attachTransport: h.attachTransport,
    });
    await Promise.resolve();
    controller.dispose();
    await vi.advanceTimersByTimeAsync(16);

    expect(h.terminal.focus).not.toHaveBeenCalled();
  });

  it("passes raw input notifications through to the raw input adapter", async () => {
    const h = createHarness();
    const onRawInput = vi.fn();

    attachPtyTerminalController({
      host: h.host,
      sessionId: "s1",
      ws: h.ws,
      relay: h.relay,
      createTerminal: h.createTerminal,
      attachRawInput: h.attachRawInput,
      attachTransport: h.attachTransport,
      onRawInput,
    });
    await Promise.resolve();

    expect(h.attachRawInput).toHaveBeenCalledWith(h.terminal, "s1", { onRawInput });
  });

  it("disposes transport, focus handler, raw input, and terminal", async () => {
    const h = createHarness();
    const controller = attachPtyTerminalController({
      host: h.host,
      sessionId: "s1",
      ws: h.ws,
      relay: h.relay,
      createTerminal: h.createTerminal,
      attachRawInput: h.attachRawInput,
      attachTransport: h.attachTransport,
    });
    await Promise.resolve();

    controller.dispose();
    h.host.dispatchEvent(new Event("pointerdown"));

    expect(h.disposeTransport).toHaveBeenCalledTimes(1);
    expect(h.disposeRawInput).toHaveBeenCalledTimes(1);
    expect(h.disposeTerminal).toHaveBeenCalledTimes(1);
    expect(h.terminal.focus).not.toHaveBeenCalled();
  });

  it("forwards output pause and flush controls to transport", async () => {
    const h = createHarness();
    const controller = attachPtyTerminalController({
      host: h.host,
      sessionId: "s1",
      ws: h.ws,
      relay: h.relay,
      createTerminal: h.createTerminal,
      attachRawInput: h.attachRawInput,
      attachTransport: h.attachTransport,
    });

    controller.setOutputPaused(true);
    await Promise.resolve();
    controller.flushOutput();
    controller.setOutputPaused(false);

    expect(h.setOutputPaused).toHaveBeenNthCalledWith(1, true);
    expect(h.flushOutput).toHaveBeenCalledTimes(1);
    expect(h.setOutputPaused).toHaveBeenLastCalledWith(false);
  });

  it("calls onError and avoids partial wiring when createTerminal rejects", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = createHarness();
    const failure = new Error("xterm init failed");
    const createTerminal = vi.fn(async () => {
      throw failure;
    });
    const onError = vi.fn();
    const onTerminalReady = vi.fn();

    attachPtyTerminalController({
      host: h.host,
      sessionId: "s1",
      ws: h.ws,
      relay: h.relay,
      createTerminal,
      attachRawInput: h.attachRawInput,
      attachTransport: h.attachTransport,
      onTerminalReady,
      onError,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(failure);
    // 失败后不应继续走后续 wiring
    expect(h.attachRawInput).not.toHaveBeenCalled();
    expect(h.attachTransport).not.toHaveBeenCalled();
    expect(onTerminalReady).not.toHaveBeenCalled();

    errSpy.mockRestore();
  });

  it("disposes an async-created terminal when cancelled before creation completes", async () => {
    const h = createHarness();
    let resolveCreate: (value: {
      terminal: typeof h.terminal;
      dispose: () => void;
    }) => void = () => {
      throw new Error("createTerminal promise was not initialized");
    };
    const createTerminal = vi.fn(
      () =>
        new Promise<{ terminal: typeof h.terminal; dispose: () => void }>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const controller = attachPtyTerminalController({
      host: h.host,
      sessionId: "s1",
      ws: h.ws,
      relay: h.relay,
      createTerminal,
      attachRawInput: h.attachRawInput,
      attachTransport: h.attachTransport,
    });
    controller.dispose();
    resolveCreate?.({ terminal: h.terminal, dispose: h.disposeTerminal });
    await Promise.resolve();

    expect(h.disposeTerminal).toHaveBeenCalledTimes(1);
    expect(h.attachRawInput).not.toHaveBeenCalled();
    expect(h.attachTransport).not.toHaveBeenCalled();
  });
});
