import { useCallback, useEffect, useMemo, useState } from "react";

export function usePtyConnectionState() {
  const [ready, setReady] = useState(false);
  const [connectingVisible, setConnectingVisible] = useState(false);
  const [subscribeDelayed, setSubscribeDelayed] = useState(false);

  useEffect(() => {
    if (ready) {
      setConnectingVisible(false);
      return;
    }
    const t = setTimeout(() => setConnectingVisible(true), 300);
    return () => clearTimeout(t);
  }, [ready]);

  const markReady = useCallback(() => {
    setReady(true);
    setSubscribeDelayed(false);
  }, []);

  const markSubscribeStarted = useCallback(() => {
    setSubscribeDelayed(false);
  }, []);

  const markSubscribeDelayed = useCallback(() => {
    setSubscribeDelayed(true);
  }, []);

  const overlay = useMemo(
    () => ({
      connecting: connectingVisible,
      subscribeDelayed,
    }),
    [connectingVisible, subscribeDelayed],
  );

  const transport = useMemo(
    () => ({
      onReady: markReady,
      onSubscribeStarted: markSubscribeStarted,
      onSubscribeDelayed: markSubscribeDelayed,
    }),
    [markReady, markSubscribeDelayed, markSubscribeStarted],
  );

  return {
    ready,
    overlay,
    transport,
  };
}
