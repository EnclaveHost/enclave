// Enclave Shield (Windows Hyper-V, tier T0-hv) evidence for APP-ZONE dns-01 pushes (network/app-zone-challenge.mjs): the
// Shield counterpart of the SEV-SNP judge there, for a Shield-direct front (isolation/m2/front/shield_direct.go) that
// certifies its own <deploymentId[2:10]>.<app zone> name with its own key (isolation/m2/front/appzone.go).
//
// Nothing here is new verification. It is the owner-name Shield responder's, unchanged (relay/dns-challenge-shield.mjs
// createShieldChallengeAuth -> verifyAttestation):
//   - the push's document is the m3 monitor's hyperv-partition-domain/v1 (tier T0-hv) carrying the guest's OWN OpenHCL VBS
//     report; a launcher-only document (no VBS report: the host's word, windows/node/hvcert.mjs) is REFUSED;
//   - the report verifies under the IDKS of a host boot session THIS replica challenged itself (shield-host-session.mjs:
//     its own nonce and credential for the TPM's EK/AK, EK chain to the operator's pinned TPM roots, quote, replayed
//     production boot log, and the host's registered operator's signature over the exchange, bound to this replica's
//     party id), binding Bind2(the push key, the push nonce, RuntimeID) || AppID;
//   - the (VBS launch digest, RuntimeID) image pair and the TPM/platform pair are ones the operator's pinned
//     enclave-shield-app-policy/1 admits; debug off.
// What this adds is the binding the SNP path gets from HOST_DATA: a VBS report names no deployment, so only a session
// of the LEASE'S RUNNER (registry id = keccak256(endpoint), the session's host), attested by the LEASE'S OPERATOR, may
// match. The push's lease is then checked against the chain by the authority, at one agreed block (runner, operator,
// owner, appRef, envelope, registry entry active = not banned, catalog admission), exactly as for SNP.
// Every verdict is hostExcluded:false: Shield never claims exclusion of the host operator.
import { createShieldChallengeAuth, SHIELD_DOC_FORMAT } from "../relay/dns-challenge-shield.mjs";
import { appZoneShieldParty } from "../windows/node/shield-verdict.mjs";

export { SHIELD_DOC_FORMAT, appZoneShieldParty };
/** where a replica serves its host sessions (distinct from an owner-name responder's /v1/shield-session) */
export const APP_ZONE_SHIELD_SESSION_PATH = "/v1/app-zone/shield-session";

/**
 * createAppZoneShield({ policy, zone, registryEntry, recoverSigner, ...limits }) -> { party, verify, handle, attest, challenge, sessions }
 *   policy        the operator's pinned enclave-shield-app-policy/1 (TPM roots, platform pairs, image pairs): no defaults
 *   zone          this replica's app zone (the party id is bound to it)
 *   registryEntry the replica's own agreeing registry read (relay/dns-challenge-shield.mjs shieldRegistryEntry)
 */
export function createAppZoneShield({ policy, zone, registryEntry, recoverSigner, ...rest }) {
  if (typeof zone !== "string" || !zone) throw new Error("the app zone is required");
  const party = appZoneShieldParty(zone);
  const auth = createShieldChallengeAuth({ ...rest, policy, zone, party, registryEntry, recoverSigner });
  // the routes under this replica's own path: the same handlers and admission limits as the owner-name responder's
  const handle = (req, res, json) => {
    const u = new URL("http://x" + req.url);
    if (!u.pathname.startsWith(APP_ZONE_SHIELD_SESSION_PATH + "/")) return Promise.resolve(false);
    const tail = u.pathname.slice(APP_ZONE_SHIELD_SESSION_PATH.length);
    if (!["/challenge", "/attest"].includes(tail)) return Promise.resolve(false);
    req.url = "/v1/shield-session" + tail + u.search;
    return auth.handle(req, res, json);
  };
  return {
    party,
    /** -> { ok, verdict, tier, hostExcluded, measurement, hostId, endpoint, operator } | { ok: false, status, why }. Never throws. */
    verify: ({ doc, spki, nonce, lease }) => {
      if (!lease || !/^0x[0-9a-f]{64}$/.test(String(lease.runner)) || !/^0x[0-9a-f]{40}$/.test(String(lease.operator)))
        return Promise.resolve({ ok: false, status: 400, why: "a Shield push must name its lease runner and operator" });
      return auth.verifyAttestation({ doc, spki, nonce, hostId: lease.runner, operator: lease.operator });
    },
    handle, attest: auth.attest, challenge: auth.challenge, sessions: auth.sessions,
  };
}
