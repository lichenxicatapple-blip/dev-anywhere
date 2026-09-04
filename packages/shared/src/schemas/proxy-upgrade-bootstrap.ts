import { z } from "zod";

export const PROXY_UPGRADE_BOOTSTRAP_VERSION = 1 as const;

const StableVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

// This small HTTP contract is deliberately separate from RelayControlSchema. A Proxy can discover
// the version it needs before it is able to speak the Relay's current WebSocket control protocol.
export const ProxyUpgradeBootstrapResponseSchema = z
  .object({
    bootstrapVersion: z.literal(PROXY_UPGRADE_BOOTSTRAP_VERSION),
    relayVersion: StableVersionSchema,
    controlProtocolVersion: z.number().int().positive(),
  })
  .strict();

export type ProxyUpgradeBootstrapResponse = z.infer<typeof ProxyUpgradeBootstrapResponseSchema>;
