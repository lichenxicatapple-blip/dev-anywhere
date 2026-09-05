import { z } from "zod";

// Machine-readable CLI results distinguish service startup from session handover.
const serviceCommandResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ready"),
    pid: z.number().int().positive(),
    instanceId: z.string().min(1),
    version: z.string(),
    missingSessionIds: z.array(z.string()),
  }),
  z.object({ status: z.literal("stopped") }),
  z.object({
    status: z.literal("failed"),
    code: z.string(),
    message: z.string(),
    recoveryToken: z.string().min(1).optional(),
  }),
]);

export type ServiceCommandResult = z.infer<typeof serviceCommandResultSchema>;

export function parseServiceCommandResult(output: string): ServiceCommandResult | null {
  try {
    const result = serviceCommandResultSchema.safeParse(JSON.parse(output.trim()));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
