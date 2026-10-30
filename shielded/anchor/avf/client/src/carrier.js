// carrier.js -- WHERE the client's bytes go (RELAY-SERVING.md; since 0.5.0). A carrier is never trusted: the client verifies
// the VM itself, and a deployment id in a carrier URL is a ROUTE only -- the app it must run comes from the signed table
// (trust.js selectDeployment), never from the URL.
//   carrierFor({ relay, relayBase, deployment }) -> { ok, url } | { ok: false, reason }
//   - relay: an explicit carrier URL (the lab carrier, or any the caller chose), used as given;
//   - relayBase: a PLATFORM relay this artifact knows, compiled in below; the carrier is <base>/x/<deployment>/pvm, the
//     relay's pVM deployment route (relay/pvm-serving.mjs). Any other base is refused: a policy, a page or a relay cannot
//     widen where this client sends. The extension's manifest grants exactly these origins, plus the lab's loopback
//     (test/pvm-client-carrier.test.mjs holds the two lists equal).
import { DEPLOYMENT_ID } from "./trust.js";

export const PLATFORM_RELAYS = ["https://api.enclave.host"];
const LAB_LOOPBACK = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

export function carrierFor({ relay = null, relayBase = null, deployment = null } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (relay && relayBase) return no("both a carrier URL and a relay base were given: ambiguous, nothing fetched or sent");
  if (relay) return { ok: true, url: relay };
  if (!relayBase) return no("no carrier: give a platform relay base or a carrier URL");
  if (!PLATFORM_RELAYS.includes(relayBase) && !LAB_LOOPBACK.test(relayBase))
    return no(`${JSON.stringify(relayBase)} is not a platform relay this client knows (${PLATFORM_RELAYS.join(", ")}; or the lab's http://127.0.0.1:<port>)`);
  if (typeof deployment !== "string" || !DEPLOYMENT_ID.test(deployment)) return no("a relay base routes by deployment: select one (0x + 64 lowercase hex)");
  return { ok: true, url: `${relayBase}/x/${deployment}/pvm` };
}
