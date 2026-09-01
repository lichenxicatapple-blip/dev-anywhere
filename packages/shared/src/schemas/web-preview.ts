import { z } from "zod";
import { IdSchema } from "./id.js";

const WEB_PREVIEW_PATH_MAX_LENGTH = 4_096;
const WEB_PREVIEW_SOURCE_URL_MAX_LENGTH = 4_096;
const WEB_PREVIEW_PUBLIC_URL_MAX_LENGTH = 65_536;
const WEB_PREVIEW_NAME_MAX_LENGTH = 256;
const WEB_PREVIEW_ERROR_MAX_LENGTH = 4_096;
const WEB_PREVIEW_HTML_ENTRY_MAX_COUNT = 1_000;

export const tunnelProviderValues = ["cloudflare", "cpolar"] as const;
export const TunnelProviderSchema = z.enum(tunnelProviderValues);
export type TunnelProvider = z.infer<typeof TunnelProviderSchema>;

export const WebPreviewPathSchema = z.string().min(1).max(WEB_PREVIEW_PATH_MAX_LENGTH);

function parseUrlSafely(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const LoopbackHttpUrlSchema = z
  .string()
  .min(1)
  .max(WEB_PREVIEW_SOURCE_URL_MAX_LENGTH)
  .url()
  .refine((value) => {
    const url = parseUrlSafely(value);
    if (!url) return false;
    if (url.protocol !== "http:" || url.username !== "" || url.password !== "") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  }, "Local preview URL must use http:// with a loopback host and no credentials");

const PublicPreviewUrlSchema = z
  .string()
  .min(1)
  .max(WEB_PREVIEW_PUBLIC_URL_MAX_LENGTH)
  .url()
  .refine((value) => {
    const url = parseUrlSafely(value);
    if (!url) return false;
    return (
      url.protocol === "https:" && url.username === "" && url.password === "" && url.port === ""
    );
  }, "Preview public URL must use standard HTTPS without credentials");

const DNS_LABEL_PATTERN = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const CLOUDFLARE_PUBLIC_HOST_PATTERN = new RegExp(
  `^${DNS_LABEL_PATTERN}\\.trycloudflare\\.com$`,
  "i",
);
const CPOLAR_PUBLIC_HOST_PATTERN = new RegExp(
  `^(?:${DNS_LABEL_PATTERN}\\.)+cpolar\\.(?:top|cn|io)$`,
  "i",
);

export const WebPreviewTunnelStatusSchema = z.object({
  available: z.boolean(),
  command: z.string().min(1).max(WEB_PREVIEW_PATH_MAX_LENGTH).optional(),
  version: z.string().min(1).max(256).optional(),
  error: z.string().min(1).max(WEB_PREVIEW_ERROR_MAX_LENGTH).optional(),
  suggestions: z.array(z.string().min(1).max(WEB_PREVIEW_PATH_MAX_LENGTH)).max(32).optional(),
});
export type WebPreviewTunnelStatus = z.infer<typeof WebPreviewTunnelStatusSchema>;

export const WebPreviewCapabilitySchema = z.object({
  supported: z.boolean(),
  cloudflared: WebPreviewTunnelStatusSchema,
  cpolar: WebPreviewTunnelStatusSchema,
});
export type WebPreviewCapability = z.infer<typeof WebPreviewCapabilitySchema>;

export const WebPreviewSourceInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    url: LoopbackHttpUrlSchema,
  }),
  z.object({
    kind: z.literal("static"),
    path: WebPreviewPathSchema,
    entryPath: WebPreviewPathSchema.optional(),
  }),
]);
export type WebPreviewSourceInput = z.infer<typeof WebPreviewSourceInputSchema>;

export const PreviewSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    url: LoopbackHttpUrlSchema,
  }),
  z.object({
    kind: z.literal("static"),
    rootPath: WebPreviewPathSchema,
    entryPath: WebPreviewPathSchema,
  }),
]);
export type PreviewSource = z.infer<typeof PreviewSourceSchema>;

export const previewStateValues = [
  "starting",
  "ready",
  "disconnected",
  "failed",
  "stopping",
] as const;
export const PreviewStateSchema = z.enum(previewStateValues);
export type PreviewState = z.infer<typeof PreviewStateSchema>;

export const PreviewSummarySchema = z
  .object({
    previewId: IdSchema,
    name: z.string().min(1).max(WEB_PREVIEW_NAME_MAX_LENGTH),
    source: PreviewSourceSchema,
    state: PreviewStateSchema,
    tunnelProvider: TunnelProviderSchema,
    publicUrl: PublicPreviewUrlSchema.optional(),
    error: z.string().min(1).max(WEB_PREVIEW_ERROR_MAX_LENGTH).optional(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .superRefine((preview, context) => {
    if (!preview.publicUrl) return;
    const publicUrl = parseUrlSafely(preview.publicUrl);
    // PublicPreviewUrlSchema reports malformed URLs. Do not let cross-field validation turn
    // safeParse into a throwing parser when URL construction itself fails.
    if (!publicUrl) return;
    const hostname = publicUrl.hostname;
    const provider = preview.tunnelProvider;
    const valid =
      provider === "cloudflare"
        ? CLOUDFLARE_PUBLIC_HOST_PATTERN.test(hostname)
        : CPOLAR_PUBLIC_HOST_PATTERN.test(hostname);
    if (!valid) {
      context.addIssue({
        code: "custom",
        path: ["publicUrl"],
        message: `Preview public URL hostname does not match tunnel provider ${provider}`,
      });
    }
  });
export type PreviewSummary = z.infer<typeof PreviewSummarySchema>;

export const PreviewHtmlEntriesSchema = z
  .array(WebPreviewPathSchema)
  .max(WEB_PREVIEW_HTML_ENTRY_MAX_COUNT);
