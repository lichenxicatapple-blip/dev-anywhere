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
  plainEnterBehavior?: "submit" | "linefeed";
}

export function attachXtermRawInput(
  term: RawInputTerminal,
  sessionId: string,
  options: XtermRawInputOptions = {},
): Disposable {
  const sendRawInput = (data: string): void => {
    sendRemoteInputRaw(sessionId, data);
    options.onRawInput?.(data);
  };

  const dataDisposable = term.onData((data) => {
    sendRawInput(data);
  });
  term.attachCustomKeyEventHandler?.((event) => {
    if (event.type !== "keydown" || event.key !== "Enter") return true;
    if (event.shiftKey || options.plainEnterBehavior === "linefeed") {
      sendRawInput("\n");
      event.preventDefault();
      return false;
    }
    return true;
  });

  return {
    dispose: () => dataDisposable.dispose(),
  };
}
