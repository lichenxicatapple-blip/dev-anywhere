import { sendRemoteInputRaw } from "./ansi-keys";

type Disposable = {
  dispose: () => void;
};

interface RawInputTerminal {
  onData: (handler: (data: string) => void) => Disposable;
}

export function attachXtermRawInput(term: RawInputTerminal, sessionId: string): Disposable {
  return term.onData((data) => {
    sendRemoteInputRaw(sessionId, data);
  });
}
