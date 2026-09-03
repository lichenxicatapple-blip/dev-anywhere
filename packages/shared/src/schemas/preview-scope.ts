import { z } from "zod";
import { IdSchema } from "./id.js";

export const PreviewScopeSchema = z
  .object({
    proxyId: IdSchema,
    bindingId: IdSchema,
  })
  .strict();

export type PreviewScope = z.infer<typeof PreviewScopeSchema>;
