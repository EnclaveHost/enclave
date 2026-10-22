// The production providers and client pattern of root's CURRENT serve-reserve.mjs (fc72357c): two independently
// operated providers (PublicNode refuses mined-receipt reads on its public tier), each provider's requests serialized
// with a ~1.1 s gap to avoid public-RPC bursts. Only scheduling: every two-provider check is unchanged.
import { createPublicClient, http } from "../enclave/node_modules/viem/_esm/index.js";
import { PRODUCTION } from "./trust.mjs";
export function productionClients(urls = PRODUCTION.rpcs) {
  return urls.map((url) => {
    let tail = Promise.resolve();
    const fetchFn = (...args) => {
      const result = tail.then(() => fetch(...args));
      tail = result.catch(() => {}).then(() => new Promise((resolve) => setTimeout(resolve, 1100)));
      return result;
    };
    return createPublicClient({ transport: http(url, { fetchFn, timeout: 30000, retryCount: 2, retryDelay: 1100 }) });
  });
}
