import { describe, expect, it } from "vitest";
import {
  clearPreviewPendingOperationsForScope,
  createPreviewPendingOperationRegistry,
  findPreviewPendingOperation,
  listPreviewPendingOperations,
  listPreviewPendingOperationsForPreview,
  registerPreviewPendingOperation,
  removePreviewPendingOperation,
  type PreviewPendingOperation,
} from "./preview-pending-operations";
import { createPreviewScope } from "./preview-scope";

function scopes() {
  return {
    a: createPreviewScope("proxy-a", "binding-a-1"),
    aRebound: createPreviewScope("proxy-a", "binding-a-2"),
    b: createPreviewScope("proxy-b", "binding-b-1"),
  };
}

function closeOperation(
  scope: ReturnType<typeof scopes>["a"],
  operationId = "operation-1",
): PreviewPendingOperation {
  return {
    kind: "close",
    previewKind: "web",
    operationId,
    fingerprint: "close:preview-1",
    scope,
    previewId: "preview-1",
    startedAt: 10,
  };
}

describe("PreviewPendingOperationRegistry", () => {
  it("registers all supported operation kinds without changing an authoritative entity", () => {
    const { a } = scopes();
    const operations: PreviewPendingOperation[] = [
      {
        kind: "create",
        previewKind: "web",
        operationId: "create-1",
        fingerprint: "web:create:one",
        scope: a,
        startedAt: 1,
      },
      {
        kind: "reconnect",
        previewKind: "web",
        operationId: "reconnect-1",
        fingerprint: "web:reconnect:preview-1",
        scope: a,
        previewId: "preview-1",
        startedAt: 2,
      },
      {
        kind: "rename",
        previewKind: "web",
        operationId: "rename-1",
        fingerprint: "web:rename:preview-1:new-name",
        scope: a,
        previewId: "preview-1",
        startedAt: 3,
      },
      {
        kind: "close",
        previewKind: "web",
        operationId: "close-1",
        fingerprint: "web:close:preview-1",
        scope: a,
        previewId: "preview-1",
        startedAt: 4,
      },
    ];

    let registry = createPreviewPendingOperationRegistry();
    for (const operation of operations) {
      const result = registerPreviewPendingOperation(registry, operation);
      expect(result.status).toBe("applied");
      registry = result.registry;
    }

    expect(
      listPreviewPendingOperations(registry, a, "web").map((operation) => operation.kind),
    ).toEqual(["create", "reconnect", "rename", "close"]);
    expect(listPreviewPendingOperationsForPreview(registry, a, "web", "preview-1")).toHaveLength(3);
  });

  it("isolates an equal operation id by Proxy and binding identity", () => {
    const { a, aRebound, b } = scopes();
    let registry = createPreviewPendingOperationRegistry();
    for (const scope of [a, aRebound, b]) {
      const result = registerPreviewPendingOperation(registry, closeOperation(scope));
      expect(result.status).toBe("applied");
      registry = result.registry;
    }

    expect(registry.operations).toHaveLength(3);
    expect(findPreviewPendingOperation(registry, a, "operation-1")?.scope).toBe(a);
    expect(findPreviewPendingOperation(registry, aRebound, "operation-1")?.scope).toBe(aRebound);
    expect(findPreviewPendingOperation(registry, b, "operation-1")?.scope).toBe(b);
  });

  it("treats an exact retry as a duplicate but reports reuse for another target as a conflict", () => {
    const { a } = scopes();
    const first = registerPreviewPendingOperation(
      createPreviewPendingOperationRegistry(),
      closeOperation(a),
    );
    expect(first.status).toBe("applied");

    const duplicate = registerPreviewPendingOperation(first.registry, closeOperation(a));
    expect(duplicate).toMatchObject({ status: "ignored", reason: "duplicate" });
    expect(duplicate.registry).toBe(first.registry);

    const conflict = registerPreviewPendingOperation(first.registry, {
      kind: "close",
      previewKind: "web",
      operationId: "operation-1",
      fingerprint: "close:preview-2",
      scope: a,
      previewId: "preview-2",
      startedAt: 10,
    });
    expect(conflict).toMatchObject({ status: "conflict", reason: "operation-id-conflict" });
    expect(conflict.registry).toBe(first.registry);
  });

  it("removes and clears only the exact scope", () => {
    const { a, aRebound } = scopes();
    const first = registerPreviewPendingOperation(
      createPreviewPendingOperationRegistry(),
      closeOperation(a),
    );
    const second = registerPreviewPendingOperation(first.registry, closeOperation(aRebound));

    const removed = removePreviewPendingOperation(second.registry, a, "operation-1");
    expect(removed.status).toBe("applied");
    expect(findPreviewPendingOperation(removed.registry, a, "operation-1")).toBeUndefined();
    expect(findPreviewPendingOperation(removed.registry, aRebound, "operation-1")).toBeDefined();

    const cleared = clearPreviewPendingOperationsForScope(removed.registry, aRebound);
    expect(cleared.operations).toEqual([]);
  });

  it("does not allocate a new registry for a missing completion or empty scope clear", () => {
    const { a, b } = scopes();
    const applied = registerPreviewPendingOperation(
      createPreviewPendingOperationRegistry(),
      closeOperation(a),
    );

    expect(removePreviewPendingOperation(applied.registry, b, "operation-1").registry).toBe(
      applied.registry,
    );
    expect(clearPreviewPendingOperationsForScope(applied.registry, b)).toBe(applied.registry);
  });

  it("rejects reusing an operation id across Web and Device commands in one scope", () => {
    const { a } = scopes();
    const web = registerPreviewPendingOperation(
      createPreviewPendingOperationRegistry(),
      closeOperation(a),
    );
    const device = registerPreviewPendingOperation(web.registry, {
      ...closeOperation(a),
      previewKind: "device",
    });

    expect(device).toMatchObject({ status: "conflict", reason: "operation-id-conflict" });
    expect(
      listPreviewPendingOperationsForPreview(device.registry, a, "web", "preview-1"),
    ).toHaveLength(1);
    expect(
      listPreviewPendingOperationsForPreview(device.registry, a, "device", "preview-1"),
    ).toHaveLength(0);
    expect(findPreviewPendingOperation(device.registry, a, "operation-1")?.previewKind).toBe("web");
  });

  it("rejects reusing an operation id with different parameters", () => {
    const { a } = scopes();
    const first = registerPreviewPendingOperation(
      createPreviewPendingOperationRegistry(),
      closeOperation(a),
    );

    const conflict = registerPreviewPendingOperation(first.registry, {
      ...closeOperation(a),
      fingerprint: "close:preview-1:different-parameters",
    });

    expect(conflict).toMatchObject({ status: "conflict", reason: "operation-id-conflict" });
    expect(conflict.registry).toBe(first.registry);
  });
});
