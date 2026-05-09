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

  it("can suppress pointerdown focus while the user is reviewing history", async () => {
    const h = createHarness();

    attachPtyTerminalController({
      host: h.host,
      sessionId: "s1",
      ws: h.ws,
      relay: h.relay,
      createTerminal: h.createTerminal,
      attachRawInput: h.attachRawInput,
      attachTransport: h.attachTransport,
      shouldFocusOnPointerDown: () => false,
    });
    await Promise.resolve();

    h.host.dispatchEvent(new Event("pointerdown"));

    expect(h.terminal.focus).not.toHaveBeenCalled();
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
