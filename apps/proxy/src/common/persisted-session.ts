import { providerValues } from "@dev-anywhere/shared";
import { z } from "zod";

const persistedSessionFields = {
  id: z.string().min(1),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  name: z.string().optional(),
  nameLocked: z.boolean().optional(),
  cwd: z.string().min(1),
  claudeSessionId: z.string().optional(),
  historySessionId: z.string().optional(),
  pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};

export const PersistedSessionRecordSchema = z.union([
  z
    .object({
      ...persistedSessionFields,
      kind: z.literal("agent"),
      mode: z.literal("pty"),
      provider: z.enum(providerValues),
      ptyOwner: z.enum(["local-terminal", "proxy-hosted"]),
    })
    .strict(),
  z
    .object({
      ...persistedSessionFields,
      kind: z.literal("agent"),
      mode: z.literal("json"),
      provider: z.enum(providerValues),
    })
    .strict(),
  z
    .object({
      ...persistedSessionFields,
      kind: z.literal("terminal"),
      mode: z.literal("pty"),
      provider: z.literal("claude"),
      ptyOwner: z.literal("local-terminal"),
    })
    .strict(),
]);

export type PersistedSessionRecord = z.infer<typeof PersistedSessionRecordSchema>;
