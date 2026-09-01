import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  PreviewSourceSchema,
  PreviewSummarySchema,
  TunnelProviderSchema,
} from "@dev-anywhere/shared";
import { atomicWriteFileSync } from "../../common/atomic-write.js";
import { serviceLogger } from "../../common/logger.js";
import type { PersistedPreviewDefinition } from "./types.js";

const PreviewDefinitionSchema = z.object({
  previewId: PreviewSummarySchema.shape.previewId,
  name: PreviewSummarySchema.shape.name,
  source: PreviewSourceSchema,
  tunnelProvider: TunnelProviderSchema,
  createdAt: PreviewSummarySchema.shape.createdAt,
  updatedAt: PreviewSummarySchema.shape.updatedAt,
  operationId: PreviewSummarySchema.shape.previewId.optional(),
});

export const MAX_PERSISTED_PREVIEWS = 100;

const PreviewStoreSchema = z.object({
  version: z.literal(1),
  previews: z.array(PreviewDefinitionSchema).max(MAX_PERSISTED_PREVIEWS),
});

export class PreviewStore {
  constructor(private readonly path: string) {}

  load(): PersistedPreviewDefinition[] {
    if (!existsSync(this.path)) return [];
    try {
      return PreviewStoreSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))).previews;
    } catch (error) {
      serviceLogger.warn(
        { path: this.path, error: String(error) },
        "Preview persistence file is invalid; keeping it untouched and starting empty",
      );
      return [];
    }
  }

  save(previews: readonly PersistedPreviewDefinition[]): void {
    atomicWriteFileSync(this.path, `${JSON.stringify({ version: 1, previews }, null, 2)}\n`, {
      ensureDir: true,
      mode: 0o600,
    });
  }
}
