import type { Terminal } from "@xterm/xterm";
import { sendRemoteInputRaw } from "./ansi-keys";

type Disposable = {
  dispose: () => void;
};

export function attachXtermRawInput(term: Pick<Terminal, "onData">, sessionId: string): Disposable {
  return term.onData((data) => {
    sendRemoteInputRaw(sessionId, data);
  });
}
