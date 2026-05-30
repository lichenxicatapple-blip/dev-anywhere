type ContainerScrollSourceDecision =
  | {
      action: "external-sync";
      nextPendingFollowTop: number | null;
      nextPendingProgrammaticTop: number | null;
    }
  | {
      action: "programmatic-follow";
      nextPendingFollowTop: null;
      nextPendingProgrammaticTop: null;
    }
  | {
      action: "programmatic-drift";
      nextPendingFollowTop: null;
      nextPendingProgrammaticTop: null;
    }
  | {
      action: "continue";
      nextPendingFollowTop: null;
      nextPendingProgrammaticTop: null;
    };

export function decideContainerScrollSource({
  syncingExternal,
  effectiveScrollTop,
  pendingFollowTop,
  pendingProgrammaticTop,
  atBottom,
  canPassiveFollow,
  tolerancePx = 1,
}: {
  syncingExternal: boolean;
  effectiveScrollTop: number;
  pendingFollowTop: number | null;
  pendingProgrammaticTop: number | null;
  atBottom: boolean;
  canPassiveFollow: boolean;
  tolerancePx?: number;
}): ContainerScrollSourceDecision {
  if (syncingExternal) {
    return {
      action: "external-sync",
      nextPendingFollowTop: pendingFollowTop,
      nextPendingProgrammaticTop: pendingProgrammaticTop,
    };
  }

  const isPendingFollow =
    pendingFollowTop !== null && Math.abs(effectiveScrollTop - pendingFollowTop) <= tolerancePx;
  if (isPendingFollow) {
    return {
      action: "programmatic-follow",
      nextPendingFollowTop: null,
      nextPendingProgrammaticTop: null,
    };
  }

  const isPendingProgrammatic =
    pendingProgrammaticTop !== null &&
    Math.abs(effectiveScrollTop - pendingProgrammaticTop) <= tolerancePx &&
    canPassiveFollow;
  if (!atBottom && isPendingProgrammatic) {
    return {
      action: "programmatic-drift",
      nextPendingFollowTop: null,
      nextPendingProgrammaticTop: null,
    };
  }

  return {
    action: "continue",
    nextPendingFollowTop: null,
    nextPendingProgrammaticTop: null,
  };
}
