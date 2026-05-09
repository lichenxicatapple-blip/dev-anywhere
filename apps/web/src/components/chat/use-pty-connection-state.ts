import { useCallback, useEffect, useMemo, useState } from "react";

export function usePtyConnectionState() {
  const [ready, setReady] = useState(false);
  const [connectingVisible, setConnectingVisible] = useState(false);
  const [subscribeExhausted, setSubscribeExhausted] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

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
    setSubscribeExhausted(false);
  }, []);

  const markSubscribeStarted = useCallback(() => {
    setSubscribeExhausted(false);
  }, []);

  const markSubscribeExhausted = useCallback(() => {
    setSubscribeExhausted(true);
  }, []);

  const retry = useCallback(() => {
    setReady(false);
    setSubscribeExhausted(false);
    setRetryNonce((n) => n + 1);
  }, []);

  const overlay = useMemo(
    () => ({
      connecting: connectingVisible,
      subscribeExhausted,
      onRetry: retry,
    }),
    [connectingVisible, retry, subscribeExhausted],
  );

  const transport = useMemo(
    () => ({
      onReady: markReady,
      onSubscribeStarted: markSubscribeStarted,
      onSubscribeExhausted: markSubscribeExhausted,
    }),
    [markReady, markSubscribeExhausted, markSubscribeStarted],
  );

  return {
    ready,
    retryNonce,
    overlay,
    transport,
  };
}
