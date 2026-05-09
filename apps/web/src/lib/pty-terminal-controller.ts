import { attachPtySessionTransport } from "./pty-session-transport";
import type { PtyRenderTarget } from "./pty-recovery";

type Disposable = { dispose: () => void };

interface CreatedTerminal {
  terminal: PtyControlledTerminal;
  dispose: () => void;
}

interface PtyControlledTerminal extends PtyRenderTarget {
  focus: () => void;
  onData: (handler: (data: string) => void) => Disposable;
}

interface PtyWebSocketLike {
  send: (data: string) => boolean;
  subscribeBinary: (
    sessionId: string,
    handler: (data: Uint8Array, outputSeq: number) => void,
  ) => () => void;
}

interface PtyRelayLike {
  onMessage: (handler: (msg: Record<string, unknown>) => void) => () => void;
}

interface PtyTerminalControllerOptions {
  host: HTMLDivElement;
  sessionId: string;
  ws: PtyWebSocketLike;
  relay: PtyRelayLike;
  createTerminal: (host: HTMLDivElement) => Promise<CreatedTerminal>;
  attachRawInput: (
    term: PtyControlledTerminal,
    sessionId: string,
    options?: { onRawInput?: (data: string) => void },
  ) => Disposable;
  attachTransport?: typeof attachPtySessionTransport;
  onTerminalReady?: (term: PtyControlledTerminal) => void;
  onFramePending?: () => void;
  onFrameWritten?: () => void;
  onRawInput?: (data: string) => void;
  onReady?: () => void;
  onSubscribeStarted?: () => void;
  onSubscribeExhausted?: () => void;
}

interface PtyTerminalController {
  dispose: () => void;
  flushOutput: () => void;
  setOutputPaused: (value: boolean) => void;
}

export function attachPtyTerminalController(
  options: PtyTerminalControllerOptions,
): PtyTerminalController {
  const {
    host,
    sessionId,
    ws,
    relay,
    createTerminal,
    attachRawInput,
    attachTransport = attachPtySessionTransport,
    onTerminalReady,
    onFramePending,
    onFrameWritten,
    onRawInput,
    onReady,
    onSubscribeStarted,
    onSubscribeExhausted,
  } = options;

  let disposed = false;
  let disposeTerminal: (() => void) | null = null;
  let disposeRawInput: (() => void) | null = null;
  let transport: ReturnType<typeof attachPtySessionTransport> | null = null;
  let removeFocusHandler: (() => void) | null = null;
  let outputPaused = false;

  void (async () => {
    const result = await createTerminal(host);
    if (disposed) {
      result.dispose();
      return;
    }

    disposeTerminal = result.dispose;
    disposeRawInput = attachRawInput(result.terminal, sessionId, { onRawInput }).dispose;

    const focusTerminal = (): void => result.terminal.focus();
    host.addEventListener("pointerdown", focusTerminal, { passive: true });
    removeFocusHandler = () => host.removeEventListener("pointerdown", focusTerminal);
    onTerminalReady?.(result.terminal);
    requestAnimationFrame(() => {
      if (!disposed) focusTerminal();
    });

    transport = attachTransport({
      sessionId,
      ws,
      relay,
      target: result.terminal,
      onFramePending,
      onFrameWritten,
      onReady,
      onSubscribeStarted,
      onSubscribeExhausted,
    });
    transport.setOutputPaused(outputPaused);
  })();

  return {
    flushOutput: () => transport?.flushOutput(),
    setOutputPaused: (value) => {
      outputPaused = value;
      transport?.setOutputPaused(value);
    },
    dispose: () => {
      disposed = true;
      transport?.dispose();
      removeFocusHandler?.();
      disposeRawInput?.();
      disposeTerminal?.();
    },
  };
}
