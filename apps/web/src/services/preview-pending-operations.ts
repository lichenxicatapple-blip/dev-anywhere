import { samePreviewScope, type PreviewScope } from "./preview-scope";

export type PreviewPendingOperationKind = "create" | "reconnect" | "rename" | "close";
export type PreviewPendingResourceKind = "web" | "device";

interface PreviewPendingOperationBase {
  readonly operationId: string;
  readonly fingerprint: string;
  readonly previewKind: PreviewPendingResourceKind;
  readonly scope: PreviewScope;
  readonly startedAt: number;
}

export type PreviewPendingOperation =
  | (PreviewPendingOperationBase & { readonly kind: "create" })
  | (PreviewPendingOperationBase & {
      readonly kind: "reconnect" | "rename" | "close";
      readonly previewId: string;
    });

export interface PreviewPendingOperationRegistry {
  readonly operations: readonly PreviewPendingOperation[];
}

export type RegisterPreviewPendingOperationResult =
  | {
      readonly status: "applied";
      readonly registry: PreviewPendingOperationRegistry;
      readonly operation: PreviewPendingOperation;
    }
  | {
      readonly status: "ignored";
      readonly reason: "duplicate";
      readonly registry: PreviewPendingOperationRegistry;
      readonly operation: PreviewPendingOperation;
    }
  | {
      readonly status: "conflict";
      readonly reason: "operation-id-conflict";
      readonly registry: PreviewPendingOperationRegistry;
      readonly existing: PreviewPendingOperation;
    };

type RemovePreviewPendingOperationResult =
  | {
      readonly status: "applied";
      readonly registry: PreviewPendingOperationRegistry;
      readonly operation: PreviewPendingOperation;
    }
  | {
      readonly status: "ignored";
      readonly reason: "not-found";
      readonly registry: PreviewPendingOperationRegistry;
    };

function freezeRegistry(
  operations: readonly PreviewPendingOperation[],
): PreviewPendingOperationRegistry {
  return Object.freeze({ operations: Object.freeze(operations.slice()) });
}

function assertOperation(operation: PreviewPendingOperation): void {
  if (operation.operationId.length === 0) {
    throw new TypeError("Preview pending operationId must not be empty");
  }
  if (operation.fingerprint.length === 0) {
    throw new TypeError("Preview pending fingerprint must not be empty");
  }
  if (operation.kind !== "create" && operation.previewId.length === 0) {
    throw new TypeError("Preview pending previewId must not be empty");
  }
  if (operation.previewKind !== "web" && operation.previewKind !== "device") {
    throw new TypeError("Preview pending previewKind must be web or device");
  }
  if (!Number.isFinite(operation.startedAt)) {
    throw new TypeError("Preview pending startedAt must be finite");
  }
}

function isSameOperation(left: PreviewPendingOperation, right: PreviewPendingOperation): boolean {
  if (
    left.kind !== right.kind ||
    left.previewKind !== right.previewKind ||
    left.fingerprint !== right.fingerprint
  ) {
    return false;
  }
  if (left.kind === "create" || right.kind === "create") return left.kind === right.kind;
  return left.previewId === right.previewId;
}

export function createPreviewPendingOperationRegistry(): PreviewPendingOperationRegistry {
  return freezeRegistry([]);
}

export function findPreviewPendingOperation(
  registry: PreviewPendingOperationRegistry,
  scope: PreviewScope,
  operationId: string,
): PreviewPendingOperation | undefined {
  return registry.operations.find(
    (operation) =>
      operation.operationId === operationId && samePreviewScope(operation.scope, scope),
  );
}

export function listPreviewPendingOperations(
  registry: PreviewPendingOperationRegistry,
  scope: PreviewScope,
  previewKind: PreviewPendingResourceKind,
): readonly PreviewPendingOperation[] {
  return registry.operations.filter(
    (operation) =>
      operation.previewKind === previewKind && samePreviewScope(operation.scope, scope),
  );
}

export function listPreviewPendingOperationsForPreview(
  registry: PreviewPendingOperationRegistry,
  scope: PreviewScope,
  previewKind: PreviewPendingResourceKind,
  previewId: string,
): readonly Exclude<PreviewPendingOperation, { kind: "create" }>[] {
  return registry.operations.filter(
    (operation): operation is Exclude<PreviewPendingOperation, { kind: "create" }> =>
      operation.kind !== "create" &&
      operation.previewKind === previewKind &&
      operation.previewId === previewId &&
      samePreviewScope(operation.scope, scope),
  );
}

export function registerPreviewPendingOperation(
  registry: PreviewPendingOperationRegistry,
  operation: PreviewPendingOperation,
): RegisterPreviewPendingOperationResult {
  assertOperation(operation);
  const existing = findPreviewPendingOperation(registry, operation.scope, operation.operationId);
  if (existing) {
    if (isSameOperation(existing, operation)) {
      return { status: "ignored", reason: "duplicate", registry, operation: existing };
    }
    return { status: "conflict", reason: "operation-id-conflict", registry, existing };
  }

  const frozenOperation = Object.freeze({ ...operation }) as PreviewPendingOperation;
  return {
    status: "applied",
    registry: freezeRegistry([...registry.operations, frozenOperation]),
    operation: frozenOperation,
  };
}

export function removePreviewPendingOperation(
  registry: PreviewPendingOperationRegistry,
  scope: PreviewScope,
  operationId: string,
): RemovePreviewPendingOperationResult {
  const index = registry.operations.findIndex(
    (operation) =>
      operation.operationId === operationId && samePreviewScope(operation.scope, scope),
  );
  if (index < 0) return { status: "ignored", reason: "not-found", registry };

  const operation = registry.operations[index]!;
  return {
    status: "applied",
    registry: freezeRegistry([
      ...registry.operations.slice(0, index),
      ...registry.operations.slice(index + 1),
    ]),
    operation,
  };
}

export function clearPreviewPendingOperationsForScope(
  registry: PreviewPendingOperationRegistry,
  scope: PreviewScope,
): PreviewPendingOperationRegistry {
  const remaining = registry.operations.filter(
    (operation) => !samePreviewScope(operation.scope, scope),
  );
  return remaining.length === registry.operations.length ? registry : freezeRegistry(remaining);
}
