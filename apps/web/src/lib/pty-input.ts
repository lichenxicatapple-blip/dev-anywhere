import { sendRemoteInputRaw } from "./ansi-keys";

type Disposable = {
  dispose: () => void;
};

interface RawInputTerminal {
  onData: (handler: (data: string) => void) => Disposable;
  attachCustomKeyEventHandler?: (handler: (event: KeyboardEvent) => boolean) => void;
}

interface XtermRawInputOptions {
  onRawInput?: (data: string) => void;
}

export function attachXtermRawInput(
  term: RawInputTerminal,
  sessionId: string,
  options: XtermRawInputOptions = {},
): Disposable {
  const dataDisposable = term.onData((data) => {
    sendRemoteInputRaw(sessionId, data);
    options.onRawInput?.(data);
  });
  term.attachCustomKeyEventHandler?.((event) => {
    if (event.type === "keydown" && event.key === "Enter" && event.shiftKey) {
      sendRemoteInputRaw(sessionId, "\n");
      options.onRawInput?.("\n");
      event.preventDefault();
      return false;
    }
    return true;
  });

  return {
    dispose: () => dataDisposable.dispose(),
  };
}
