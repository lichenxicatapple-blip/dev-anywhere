import { describe, expect, it, vi } from "vitest";
import {
  PreviewOperationJournal,
  PreviewOperationJournalError,
  fingerprintPreviewOperationParameters,
} from "#src/serve/preview/preview-operation-journal.js";

describe("PreviewOperationJournal", () => {
  it("joins in-flight work and replays the settled result for the same operation", async () => {
    let finish!: (value: string) => void;
    const execute = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const journal = new PreviewOperationJournal();
    const parameters = { previewId: "preview-1", name: "Checkout" };

    const first = journal.run("operation-1", "web:rename", parameters, execute);
    const joined = journal.run("operation-1", "web:rename", parameters, execute);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledOnce();
    finish("Checkout");
    await expect(Promise.all([first, joined])).resolves.toEqual(["Checkout", "Checkout"]);
    await expect(journal.run("operation-1", "web:rename", parameters, execute)).resolves.toBe(
      "Checkout",
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("replays a settled failure without executing the mutation again", async () => {
    const failure = new Error("rename failed");
    const execute = vi.fn(async () => Promise.reject(failure));
    const journal = new PreviewOperationJournal();
    const parameters = { previewId: "preview-1", name: "Checkout" };

    await expect(journal.run("operation-1", "web:rename", parameters, execute)).rejects.toBe(
      failure,
    );
    await expect(journal.run("operation-1", "web:rename", parameters, execute)).rejects.toBe(
      failure,
    );
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects operationId reuse across different parameters or kinds", async () => {
    const journal = new PreviewOperationJournal();
    await journal.run(
      "operation-1",
      "web:rename",
      { previewId: "preview-1", name: "Checkout" },
      () => "Checkout",
    );

    for (const attempt of [
      () =>
        journal.run(
          "operation-1",
          "web:rename",
          { previewId: "preview-1", name: "Other" },
          () => "Other",
        ),
      () =>
        journal.run(
          "operation-1",
          "device:rename",
          { previewId: "preview-1", name: "Checkout" },
          () => "Checkout",
        ),
    ]) {
      expect(attempt).toThrowError(PreviewOperationJournalError);
      expect(attempt).toThrowError(/operationId/u);
    }
  });

  it("never evicts in-flight work but evicts the oldest settled entry", async () => {
    let finish!: () => void;
    const journal = new PreviewOperationJournal({ maxEntries: 1 });
    const first = journal.run(
      "operation-1",
      "web:close",
      { previewId: "preview-1" },
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    expect(() =>
      journal.run("operation-2", "web:close", { previewId: "preview-2" }, () => undefined),
    ).toThrow(/待处理/u);

    finish();
    await first;
    await expect(
      journal.run("operation-2", "web:close", { previewId: "preview-2" }, () => "done"),
    ).resolves.toBe("done");
  });

  it("expires settled entries and fingerprints object keys canonically", async () => {
    let now = 0;
    const execute = vi.fn(() => "done");
    const journal = new PreviewOperationJournal({ settledTtlMs: 10, now: () => now });
    expect(fingerprintPreviewOperationParameters({ b: 2, a: 1 })).toBe(
      fingerprintPreviewOperationParameters({ a: 1, b: 2 }),
    );

    await journal.run("operation-1", "device:close", { previewId: "preview-1" }, execute);
    now = 10;
    await journal.run("operation-1", "device:close", { previewId: "preview-1" }, execute);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
