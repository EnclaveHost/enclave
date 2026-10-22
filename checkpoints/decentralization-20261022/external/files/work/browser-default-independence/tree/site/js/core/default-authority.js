/* ============================================================
   The on-chain half of the packaged default profile's authority check
   (js/core/independent.js checks the bytes at load).

   At ONE block the profile's RPCs agree on, every contract of the
   reviewed authority profile must carry exactly its reviewed runtime
   code (hash and size) and its pinned immutable bindings
   (js/core/authority-profile.js observeAuthority). Until that holds,
   every agreed decision of this page (js/core/independent-chain.js
   reader) and every send refuses with the reason; nothing falls back
   to Enclave's API or address book.

   Reviewed MUTABLE values (an owner, a pending owner, a payout, the
   ledger's retirement) are different: they are reported as drift,
   loudly, but they do not stop the page. A pinned contract's owner
   could otherwise disable every default frontend at will by moving
   pendingOwner, which is exactly the veto this mode removes. Every
   method this page relies on is still checked against agreed code
   before use, and the ledger enforces its own retirement.

   Status: unchecked | verifying | verified{block,hash,at,drift[]} |
           refused{problems[]} | unavailable{reason}. A result is reused
   for 10 minutes; `enclave:authority` announces every change.
   ============================================================ */
import { INDEPENDENT } from "./config.js";
import { observeAuthority, authorityProblems } from "./authority-profile.js";

export const AUTHORITY_MAX_AGE_MS = 10 * 60 * 1000;

export class AuthorityError extends Error {
  constructor(message, status){ super(message); this.name = "AuthorityError"; this.status = status || null; this.authority = true; }
}

export const authorityApplies = () => INDEPENDENT.state === "on" && INDEPENDENT.source === "default" && !!INDEPENDENT.authority;

let status = { state: authorityApplies() ? "unchecked" : "not-applicable" };
let inflight = null;
const publish = (s) => {
  status = Object.freeze({ ...s });
  try { document.dispatchEvent(new CustomEvent("enclave:authority", { detail: status })); } catch {}
  return status;
};
export const authorityStatus = () => status;
export const _resetAuthorityForTests = () => { status = { state: authorityApplies() ? "unchecked" : "not-applicable" }; inflight = null; };

/* Split checkObservation's problems: code and immutable bindings refuse; reviewed mutable state is drift. */
export function classifyProblems(problems){
  const drift = problems.filter((p) => / reviewed mutable state changed /.test(p));
  return { hard: problems.filter((p) => !drift.includes(p)), drift };
}

export async function ensureAuthority(reader, { force = false, maxAgeMs = AUTHORITY_MAX_AGE_MS } = {}){
  if (!authorityApplies()) return publish({ state: "not-applicable" });
  if (!force && status.state === "verified" && Date.now() - status.at < maxAgeMs) return status;
  if (inflight) return inflight;
  inflight = (async () => {
    publish({ state: "verifying", previous: status.state });
    try {
      const obs = await observeAuthority(INDEPENDENT.authority, reader);
      const { hard, drift } = classifyProblems(authorityProblems(INDEPENDENT.authority, obs));
      if (hard.length) return publish({ state: "refused", problems: hard, drift, block: obs.blockNumber, at: Date.now() });
      return publish({ state: "verified", block: obs.blockNumber, hash: obs.blockHash, blockTime: obs.timestamp, agreeing: obs.rpcs.length,
        drift, at: Date.now() });
    } catch (e){
      return publish({ state: "unavailable", reason: String((e && e.message) || e).slice(0, 300), at: Date.now() });
    } finally { inflight = null; }
  })();
  return inflight;
}

/* What a decision or a send awaits. Not the packaged default (an owner-chosen profile, the hosted service): no-op. */
export async function requireAuthority(reader){
  const s = await ensureAuthority(reader);
  if (s.state === "not-applicable" || s.state === "verified") return s;
  if (s.state === "refused") throw new AuthorityError("The default network profile's contracts do not match their reviewed code at block " + s.block
    + ": " + s.problems.slice(0, 4).join("; ") + ". Nothing is read for decisions or signed until this is resolved; you can choose your own network profile instead.", s);
  throw new AuthorityError("The default network profile's contracts could not be checked against their reviewed code: " + (s.reason || "no agreement yet")
    + ". Nothing is signed until the chain endpoints agree; this page does not fall back to Enclave's hosted service.", s);
}

/* A short line for banners and panels. */
export function authorityLine(s = status){
  switch (s.state){
    case "verified": return "Reviewed contracts verified at block " + s.block + (s.agreeing ? " (" + s.agreeing + " chain endpoints agree)" : "")
      + (s.drift && s.drift.length ? " · governance changed since review: " + s.drift.join("; ") : "");
    case "verifying": return "Checking the reviewed contracts against the chain…";
    case "refused": return "Refused: the contracts do not match their reviewed code (" + s.problems.slice(0, 3).join("; ") + ")";
    case "unavailable": return "Not verified yet: " + s.reason;
    case "unchecked": return "Not checked yet";
    default: return "";
  }
}
