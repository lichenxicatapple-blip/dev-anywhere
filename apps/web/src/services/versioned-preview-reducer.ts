import { samePreviewScope, type PreviewScope } from "./preview-scope";

interface VersionedPreviewEntity {
  readonly previewId: string;
}

interface VersionedPreviewStateBase<TEntity extends VersionedPreviewEntity> {
  readonly scope: PreviewScope;
  readonly previews: readonly TEntity[];
}

export type VersionedPreviewState<TEntity extends VersionedPreviewEntity> =
  | (VersionedPreviewStateBase<TEntity> & {
      readonly syncStatus: "awaiting-snapshot";
      readonly epoch: null;
      readonly revision: -1;
    })
  | (VersionedPreviewStateBase<TEntity> & {
      readonly syncStatus: "synchronized";
      readonly epoch: string;
      readonly revision: number;
    })
  | (VersionedPreviewStateBase<TEntity> & {
      readonly syncStatus: "needs-resync";
      readonly epoch: string | null;
      readonly revision: number;
      readonly resyncCause: VersionedPreviewResyncCause;
    });

export interface VersionedPreviewResyncCause {
  readonly reason: "unknown-epoch" | "revision-gap";
  readonly observedEpoch: string;
  readonly observedRevision: number;
}

interface VersionedPreviewSnapshot<TEntity extends VersionedPreviewEntity> {
  readonly kind: "snapshot";
  readonly scope: PreviewScope;
  readonly epoch: string;
  readonly revision: number;
  readonly previews: readonly TEntity[];
}

type VersionedPreviewEvent<TEntity extends VersionedPreviewEntity> =
  | {
      readonly kind: "state";
      readonly scope: PreviewScope;
      readonly epoch: string;
      readonly revision: number;
      readonly preview: TEntity;
    }
  | {
      readonly kind: "removed";
      readonly scope: PreviewScope;
      readonly epoch: string;
      readonly revision: number;
      readonly previewId: string;
    };

type VersionedPreviewInput<TEntity extends VersionedPreviewEntity> =
  | VersionedPreviewSnapshot<TEntity>
  | VersionedPreviewEvent<TEntity>;

export type VersionedPreviewReduceResult<TEntity extends VersionedPreviewEntity> =
  | {
      readonly status: "applied";
      readonly reason: "snapshot" | "epoch-replaced" | "event";
      readonly state: VersionedPreviewState<TEntity> & { readonly syncStatus: "synchronized" };
    }
  | {
      readonly status: "ignored";
      readonly reason: "scope-mismatch" | "duplicate-revision" | "stale-revision";
      readonly state: VersionedPreviewState<TEntity>;
    }
  | {
      readonly status: "needs-resync";
      readonly reason: "unknown-epoch" | "revision-gap" | "resync-pending";
      readonly state: VersionedPreviewState<TEntity> & { readonly syncStatus: "needs-resync" };
    };

function freezePreviews<TEntity extends VersionedPreviewEntity>(
  previews: readonly TEntity[],
): readonly TEntity[] {
  return Object.freeze(previews.slice());
}

function assertVersion(epoch: string, revision: number): void {
  if (epoch.length === 0) throw new TypeError("Preview epoch must not be empty");
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("Preview revision must be a non-negative safe integer");
  }
}

function assertUniquePreviewIds<TEntity extends VersionedPreviewEntity>(
  previews: readonly TEntity[],
): void {
  const ids = new Set<string>();
  for (const preview of previews) {
    if (preview.previewId.length === 0) throw new TypeError("Preview id must not be empty");
    if (ids.has(preview.previewId)) {
      throw new TypeError(`Duplicate preview id in snapshot: ${preview.previewId}`);
    }
    ids.add(preview.previewId);
  }
}

function synchronizedState<TEntity extends VersionedPreviewEntity>(
  scope: PreviewScope,
  epoch: string,
  revision: number,
  previews: readonly TEntity[],
): VersionedPreviewState<TEntity> & { readonly syncStatus: "synchronized" } {
  return Object.freeze({
    scope,
    syncStatus: "synchronized" as const,
    epoch,
    revision,
    previews: freezePreviews(previews),
  });
}

function needsResyncState<TEntity extends VersionedPreviewEntity>(
  state: VersionedPreviewState<TEntity>,
  cause: VersionedPreviewResyncCause,
): VersionedPreviewState<TEntity> & { readonly syncStatus: "needs-resync" } {
  return Object.freeze({
    scope: state.scope,
    syncStatus: "needs-resync" as const,
    epoch: state.epoch,
    revision: state.revision,
    previews: state.previews,
    resyncCause: Object.freeze(cause),
  });
}

function upsertPreview<TEntity extends VersionedPreviewEntity>(
  previews: readonly TEntity[],
  preview: TEntity,
): readonly TEntity[] {
  const index = previews.findIndex((candidate) => candidate.previewId === preview.previewId);
  if (index < 0) return [...previews, preview];
  return previews.map((candidate, candidateIndex) =>
    candidateIndex === index ? preview : candidate,
  );
}

function reduceSnapshot<TEntity extends VersionedPreviewEntity>(
  state: VersionedPreviewState<TEntity>,
  snapshot: VersionedPreviewSnapshot<TEntity>,
): VersionedPreviewReduceResult<TEntity> {
  assertVersion(snapshot.epoch, snapshot.revision);
  assertUniquePreviewIds(snapshot.previews);
  if (!samePreviewScope(state.scope, snapshot.scope)) {
    return { status: "ignored", reason: "scope-mismatch", state };
  }

  if (state.syncStatus === "needs-resync") {
    const cause = state.resyncCause;
    if (snapshot.epoch === cause.observedEpoch && snapshot.revision < cause.observedRevision) {
      return { status: "needs-resync", reason: "resync-pending", state };
    }
    return {
      status: "applied",
      reason: state.epoch !== snapshot.epoch ? "epoch-replaced" : "snapshot",
      state: synchronizedState(state.scope, snapshot.epoch, snapshot.revision, snapshot.previews),
    };
  }

  if (state.syncStatus === "synchronized" && state.epoch === snapshot.epoch) {
    if (snapshot.revision < state.revision) {
      return { status: "ignored", reason: "stale-revision", state };
    }
    if (snapshot.revision === state.revision) {
      return { status: "ignored", reason: "duplicate-revision", state };
    }
  }

  return {
    status: "applied",
    reason:
      state.syncStatus === "synchronized" && state.epoch !== snapshot.epoch
        ? "epoch-replaced"
        : "snapshot",
    state: synchronizedState(state.scope, snapshot.epoch, snapshot.revision, snapshot.previews),
  };
}

function updateResyncCause<TEntity extends VersionedPreviewEntity>(
  state: VersionedPreviewState<TEntity> & { readonly syncStatus: "needs-resync" },
  event: VersionedPreviewEvent<TEntity>,
): VersionedPreviewState<TEntity> & { readonly syncStatus: "needs-resync" } {
  const previous = state.resyncCause;
  const observedRevision =
    previous.observedEpoch === event.epoch
      ? Math.max(previous.observedRevision, event.revision)
      : event.revision;
  if (previous.observedEpoch === event.epoch && previous.observedRevision === observedRevision) {
    return state;
  }
  return needsResyncState(state, {
    reason: previous.observedEpoch === event.epoch ? previous.reason : "unknown-epoch",
    observedEpoch: event.epoch,
    observedRevision,
  });
}

function reduceEvent<TEntity extends VersionedPreviewEntity>(
  state: VersionedPreviewState<TEntity>,
  event: VersionedPreviewEvent<TEntity>,
): VersionedPreviewReduceResult<TEntity> {
  assertVersion(event.epoch, event.revision);
  if (event.kind === "state" && event.preview.previewId.length === 0) {
    throw new TypeError("Preview id must not be empty");
  }
  if (event.kind === "removed" && event.previewId.length === 0) {
    throw new TypeError("Preview id must not be empty");
  }
  if (!samePreviewScope(state.scope, event.scope)) {
    return { status: "ignored", reason: "scope-mismatch", state };
  }

  if (state.syncStatus === "needs-resync") {
    return {
      status: "needs-resync",
      reason: "resync-pending",
      state: updateResyncCause(state, event),
    };
  }

  if (state.syncStatus === "awaiting-snapshot" || state.epoch !== event.epoch) {
    const resyncState = needsResyncState(state, {
      reason: "unknown-epoch",
      observedEpoch: event.epoch,
      observedRevision: event.revision,
    });
    return { status: "needs-resync", reason: "unknown-epoch", state: resyncState };
  }

  if (event.revision < state.revision) {
    return { status: "ignored", reason: "stale-revision", state };
  }
  if (event.revision === state.revision) {
    return { status: "ignored", reason: "duplicate-revision", state };
  }
  if (event.revision !== state.revision + 1) {
    const resyncState = needsResyncState(state, {
      reason: "revision-gap",
      observedEpoch: event.epoch,
      observedRevision: event.revision,
    });
    return { status: "needs-resync", reason: "revision-gap", state: resyncState };
  }

  const previews =
    event.kind === "state"
      ? upsertPreview(state.previews, event.preview)
      : state.previews.filter((preview) => preview.previewId !== event.previewId);
  return {
    status: "applied",
    reason: "event",
    state: synchronizedState(state.scope, state.epoch, event.revision, previews),
  };
}

export function createVersionedPreviewState<TEntity extends VersionedPreviewEntity>(
  scope: PreviewScope,
): VersionedPreviewState<TEntity> & { readonly syncStatus: "awaiting-snapshot" } {
  return Object.freeze({
    scope,
    syncStatus: "awaiting-snapshot" as const,
    epoch: null,
    revision: -1 as const,
    previews: Object.freeze([]) as readonly TEntity[],
  });
}

export function reduceVersionedPreviewState<TEntity extends VersionedPreviewEntity>(
  state: VersionedPreviewState<TEntity>,
  input: VersionedPreviewInput<TEntity>,
): VersionedPreviewReduceResult<TEntity> {
  return input.kind === "snapshot" ? reduceSnapshot(state, input) : reduceEvent(state, input);
}
