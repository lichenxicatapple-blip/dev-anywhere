import type {
  PreviewSource,
  PreviewState,
  PreviewSummary,
  TunnelProvider,
  WebPreviewSourceInput,
} from "@dev-anywhere/shared";

export type { PreviewSource, PreviewState, PreviewSummary, TunnelProvider };
export type StaticPreviewSource = Extract<PreviewSource, { kind: "static" }>;

export interface PreviewDefinition {
  previewId: string;
  name: string;
  source: PreviewSource;
  tunnelProvider: TunnelProvider;
  createdAt: number;
  updatedAt: number;
}

export interface PersistedPreviewDefinition extends PreviewDefinition {
  operationId: string;
  operationFingerprint: string;
}

export interface PreviewSnapshot {
  epoch: string;
  revision: number;
  previews: PreviewSummary[];
}

export type PreviewCreateInput = WebPreviewSourceInput;

export interface StaticPreviewInspection {
  rootPath: string;
  entryPath?: string;
  htmlEntries: string[];
}
