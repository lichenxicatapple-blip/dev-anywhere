import type {
  PreviewSource,
  PreviewState,
  PreviewSummary,
  TunnelProvider,
  WebPreviewCapability as SharedWebPreviewCapability,
  WebPreviewSourceInput,
} from "@dev-anywhere/shared";

export type WebPreviewState = PreviewState;
export type WebPreviewCapability = SharedWebPreviewCapability;
type WebPreviewInput = WebPreviewSourceInput;
type WebPreviewSource = PreviewSource;
export type WebPreviewSummary = PreviewSummary;

export interface WebPreviewSnapshot {
  epoch: string;
  revision: number;
  previews: WebPreviewSummary[];
}

export interface WebPreviewStaticInspection {
  rootPath: string;
  entryPath?: string;
  htmlEntries: string[];
}

function displayNameForPreviewInput(input: WebPreviewInput): string {
  if (input.kind === "local") {
    try {
      const url = new URL(input.url);
      const suffix = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
      return `${url.host}${suffix}`;
    } catch {
      return input.url;
    }
  }

  const cleaned = input.path.replace(/\/+$/, "");
  return cleaned.split("/").pop() || "网页预览";
}

export function startingPreviewFromAcceptedInput(
  previewId: string,
  input: WebPreviewInput,
  tunnelProvider: TunnelProvider,
  inspection?: WebPreviewStaticInspection | null,
  now = Date.now(),
): WebPreviewSummary {
  const source: WebPreviewSource =
    input.kind === "local"
      ? input
      : {
          kind: "static",
          rootPath: inspection?.rootPath ?? input.path.replace(/\/+$/, ""),
          entryPath: input.entryPath ?? inspection?.entryPath ?? "",
        };
  return {
    previewId,
    name: displayNameForPreviewInput(input),
    source,
    state: "starting",
    tunnelProvider,
    createdAt: now,
    updatedAt: now,
  };
}
