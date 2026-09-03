import type {
  PreviewSummary,
  WebPreviewCapability as SharedWebPreviewCapability,
} from "@dev-anywhere/shared";

export type WebPreviewCapability = SharedWebPreviewCapability;
export type WebPreviewSummary = PreviewSummary;

export interface WebPreviewSnapshot {
  epoch: string;
  revision: number;
  previews: WebPreviewSummary[];
}

export interface WebPreviewStaticInspection {
  entryPath?: string;
  htmlEntries: string[];
}
