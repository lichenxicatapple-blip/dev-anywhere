import { create } from "zustand";
import { devtools } from "zustand/middleware";
import {
  clearPreviewPendingOperationsForScope,
  createPreviewPendingOperationRegistry,
  registerPreviewPendingOperation,
  removePreviewPendingOperation,
  type PreviewPendingOperation,
  type PreviewPendingOperationRegistry,
  type PreviewPendingResourceKind,
  type RegisterPreviewPendingOperationResult,
} from "@/services/preview-pending-operations";
import { samePreviewScope, type PreviewScope } from "@/services/preview-scope";

interface PreviewOperationStoreState {
  registry: PreviewPendingOperationRegistry;
  begin: (operation: PreviewPendingOperation) => RegisterPreviewPendingOperationResult;
  finish: (scope: PreviewScope, operationId: string) => void;
  clearScope: (scope: PreviewScope) => void;
  clear: () => void;
}

export const usePreviewOperationStore = create<PreviewOperationStoreState>()(
  devtools(
    (set, get) => ({
      registry: createPreviewPendingOperationRegistry(),
      begin: (operation) => {
        const result = registerPreviewPendingOperation(get().registry, operation);
        if (result.registry !== get().registry) set({ registry: result.registry });
        return result;
      },
      finish: (scope, operationId) => {
        const result = removePreviewPendingOperation(get().registry, scope, operationId);
        if (result.registry !== get().registry) set({ registry: result.registry });
      },
      clearScope: (scope) => {
        const registry = clearPreviewPendingOperationsForScope(get().registry, scope);
        if (registry !== get().registry) set({ registry });
      },
      clear: () => set({ registry: createPreviewPendingOperationRegistry() }),
    }),
    { name: "preview-operation-store" },
  ),
);

export function hasPendingPreviewOperation(
  state: PreviewOperationStoreState,
  scope: PreviewScope | null,
  previewKind: PreviewPendingResourceKind,
  previewId: string,
  kind?: Exclude<PreviewPendingOperation["kind"], "create">,
): boolean {
  if (!scope) return false;
  return state.registry.operations.some(
    (operation) =>
      operation.kind !== "create" &&
      operation.previewKind === previewKind &&
      operation.previewId === previewId &&
      samePreviewScope(operation.scope, scope) &&
      (kind === undefined || operation.kind === kind),
  );
}
