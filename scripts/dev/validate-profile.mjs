// Run through tsx before stopping development services, using the Proxy's own validation.
import { loadConfig } from "../../apps/proxy/src/common/config.ts";

const relayIndex = process.argv.indexOf("--relay");
const config = loadConfig({ relayName: relayIndex < 0 ? undefined : process.argv[relayIndex + 1] });
if (!config.relayUrl)
  throw new Error(`No Relay URL configured for profile "${config.profileName}"`);
