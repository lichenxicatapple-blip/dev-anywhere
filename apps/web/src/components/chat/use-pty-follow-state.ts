import { useCallback, useEffect, useRef, useState } from "react";

export function usePtyFollowState() {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [hasNewFramesWhileAway, setHasNewFramesWhileAway] = useState(false);
  const hasNewFramesWhileAwayRef = useRef(hasNewFramesWhileAway);

  useEffect(() => {
    hasNewFramesWhileAwayRef.current = hasNewFramesWhileAway;
  }, [hasNewFramesWhileAway]);

  const handleAtBottomChange = useCallback((value: boolean) => {
    setIsAtBottom(value);
    if (value) setHasNewFramesWhileAway(false);
  }, []);

  const clearNewFramesWhileAway = useCallback(() => {
    setHasNewFramesWhileAway(false);
  }, []);

  return {
    isAtBottom,
    hasNewFramesWhileAway,
    hasNewFramesWhileAwayRef,
    setHasNewFramesWhileAway,
    handleAtBottomChange,
    clearNewFramesWhileAway,
  };
}
