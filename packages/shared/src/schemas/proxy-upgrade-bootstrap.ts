import { z } from "zod";

export const PROXY_UPGRADE_BOOTSTRAP_VERSION = 1 as const;

const StableVersionSchema = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);

// This small HTTP contract is deliberately separate from RelayControlSchema. A Proxy can discover
// the version it needs before it is able to speak the Relay's current WebSocket control protocol.
// Keep the reader forward-compatible: future Relays may append negotiation hints, and an older
// Proxy must still be able to read relayVersion and update itself instead of rejecting the very
// response intended to recover it.
export const ProxyUpgradeBootstrapResponseSchema = z.object({
  bootstrapVersion: z.literal(PROXY_UPGRADE_BOOTSTRAP_VERSION),
  relayVersion: StableVersionSchema,
  controlProtocolVersion: z.number().int().positive(),
});

export type ProxyUpgradeBootstrapResponse = z.infer<typeof ProxyUpgradeBootstrapResponseSchema>;
