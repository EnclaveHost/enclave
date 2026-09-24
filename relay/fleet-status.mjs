// relay/fleet-status.mjs -- what a fleet row IS, in words a reader can act on: online or offline, and
// when it is online but takes no tenant work, WHICH property is missing.
//
// Why this exists as its own module. Two things were being conflated on the panel:
//
//   1. "not serving" covered both a box the relay has not heard from and a box that is attached,
//      healthy and answering, but excluded from tenant work. Those are different situations for an
//      operator: one is an outage, the other is a deliberate admission decision.
//   2. the reason a row was excluded was keyed on its MODE, so every box attached in one mode got the
//      same sentence whatever its own evidence said. A sentence that is true of a class is not
//      evidence about a member of it, and an operator reading it cannot tell what to fix.
//
// What has NOT changed, and must not: eligibility itself. The relay admits tenant work on verified
// evidence (api-relay.js computeEligible), and nothing here widens that. These functions only say, of
// a row already judged ineligible, what is missing. A box's own claim that it meets the contract is a
// self-report; it appears here as "the relay holds no evidence", never as a pass.

/** Coarse state of a row, so nothing downstream has to infer it from an absence. */
export function hostStatus(e, { serving = false, staleAfterSec = 3600, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!e) return "offline";
  const seen = Number(e.lastSeen || 0);
  if (seen > 0 && nowSec - seen > staleAfterSec) return "offline";
  if (!e.tunnel && seen === 0) return "offline";
  if (serving) return "serving";
  return "online";          // attached and answering, but taking no tenant work: see `ineligible`
}

// The properties the isolation contract asks of a host before a tenant's app may run on it, each
// read from what the box publishes about ITSELF. They are not proof - a box states them - which is
// why they only ever produce a REASON here, never an admission.
function contractGaps(a, tier) {
  const gaps = [];
  const appTls = a.appTls || {};
  const session = a.session || {};
  const apps = a.apps || {};
  if (apps.inTee === false) gaps.push("its apps run outside the measured layer");
  if (appTls.terminatesIn && appTls.terminatesIn !== "enclave") gaps.push(`app TLS terminates in the ${appTls.terminatesIn}`);
  if (appTls.keyIn && appTls.keyIn !== "enclave") gaps.push(`the app-zone TLS key is in the ${appTls.keyIn}`);
  if (session.keyIn && session.keyIn !== "enclave") gaps.push(`the session-signing key is in the ${session.keyIn}`);
  if (typeof apps.contractGap === "string" && apps.contractGap) gaps.push(apps.contractGap);
  if (tier && tier !== "vbs") gaps.push(`its trusted layer is tier ${tier}, a development build rather than a production-signed one`);
  return gaps;
}

/**
 * Why a box that IS attached takes no work at all, in its own published terms. Null when it is
 * claiming, or when it says nothing about why.
 *
 * This is a SECOND axis and not a substitute for eligibility. `ineligible` is the relay's verdict
 * on a box's evidence; this is the box's own report that it is not accepting work, which is the
 * half an operator could not see. nucbox-k11 sat at claimEnabled:false for a day and a half with
 * an empty operator key, while the only sentence on the panel was about its isolation class -- true
 * of the class, and useless for the actual outage. A box states these; they are reports, not proof,
 * and the wording says so.
 */
export function claimBlockReason(e) {
  const a = e?.availability || {};
  if (a.claimEnabled !== false) return null;
  if (a.gasRenewalsLeft === 0) {
    return "it reports its operator key is out of gas: with no renewals left it can neither claim a lease nor renew one, so any app it held has already lapsed";
  }
  if (a.registered === false) return "it reports it is not registered on the ledger yet";
  if (a.ok === false) return "it reports itself unhealthy";
  if (a.apps && a.apps.isolationContract === false) {
    return "it reports it does not meet the isolation contract, so it declines tenant work whatever its scope config asks for";
  }
  return "it reports that it is not taking work, without saying why";
}

/**
 * Why a row is NOT eligible for tenant work, in the words the fleet panel prints. Null when it is.
 *
 * `eligible` and `lane` are the relay's own verdicts, passed in so this module states reasons and
 * decides nothing.
 */
export function ineligibleReason(e, { eligible = false, lane = null } = {}) {
  if (!e || e.relay) return "carries traffic only";
  if (eligible) return null;
  if (e.tunnel) {
    const m = String(e.mode || "");
    const a = e.availability || {};
    if (m === "vbs") {
      // Evidence-derived, and specific: the box publishes where its app traffic and its keys live,
      // and the relay publishes the tier it verified at attach. Name what is actually missing on
      // THIS box rather than repeating a sentence about a class of boxes.
      const gaps = contractGaps(a, String(e.tier || ""));
      return gaps.length
        ? `verified enclave report; it takes no tenant work because ${gaps.join("; ")}`
        : "verified enclave report; the relay holds no evidence that this box's app traffic and keys stay inside its measured layer, and a box's own word is not evidence";
    }
    if (m === "avf") return lane ? "pVM CPU tier: an inference lane on its owner's phone, not app deployments"
                        : e.capsRefused ? "verified protected-VM chain; its pVM CPU capability report was refused"
                        : "verified protected-VM chain; no pVM CPU capability report admitted yet";
    return "attached on a token, no hardware quote verified";
  }
  const t = String(e.availability?.teeCpu || "");
  const gpu = (e.availability?.gpu === true || (e.availability?.shielded && e.availability.shielded.vramGb > 0))
    ? "; its GPU is exposed only through Enclave Shield, whose evidence it has not presented" : "";
  return (t ? `its attestation document presents ${t}, not a confidential CPU` : "its build never named its CPU technology") + gpu;
}
