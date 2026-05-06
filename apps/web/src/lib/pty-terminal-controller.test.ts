import { describe, expect, it, vi } from "vitest";
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
    attachTransport: vi.fn(() => ({ dispose: disposeTransport })),
  };
}

describe("attachPtyTerminalController", () => {
  it("creates xterm, attaches raw input, focus handler, and transport", async () => {
    const h = createHarness();
    const onTerminalReady = vi.fn();
    const onReady = vi.fn();

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
    });
    await Promise.resolve();

    expect(h.createTerminal).toHaveBeenCalledWith(h.host);
    expect(h.attachRawInput).toHaveBeenCalledWith(h.terminal, "s1");
    expect(onTerminalReady).toHaveBeenCalledWith(h.terminal);
    expect(h.attachTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        ws: h.ws,
        relay: h.relay,
        target: h.terminal,
        onReady,
      }),
    );

    h.host.dispatchEvent(new Event("pointerdown"));
    expect(h.terminal.focus).toHaveBeenCalledTimes(1);
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
