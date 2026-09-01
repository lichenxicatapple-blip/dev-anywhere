import { useEffect } from "react";
import { useCommandStore } from "@/stores/command-store";

/** Keep the slash-command projection aligned with the session shown by ChatPage. */
export function useChatCommandSession(sessionId: string): void {
  useEffect(() => {
    useCommandStore.getState().setActiveSession(sessionId);

    return () => {
      const store = useCommandStore.getState();
      // A route transition can activate its new session before an older tree finishes
      // unmounting. Never let the stale cleanup clear that newer projection.
      if (store.activeSessionId === sessionId) store.setActiveSession(null);
    };
  }, [sessionId]);
}
