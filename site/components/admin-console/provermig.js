/* ============================================================
   Proof-of-time prover binding for the admin console.

   Why this exists: EnclaveProofOfTime holds the ledger it proves
   against as an IMMUTABLE, and EnclaveDeployments.setProver is
   ONE-SHOT. So every ledger redeploy needs a fresh prover deployed
   after it, bound once, and published under the book's
   `proofOfTime` key - three transactions in three places (a
   deploy card, a Bind row, a book row). The rev-13 migration on
   2026-08-16 shipped without that step: the book kept publishing
   the rev-12 prover, whose deployments() is the OLD ledger, so
   every checkpoint the fleet signed reverted "not the runner" and
   from the proofRequiredFrom cutover (2026-08-30) every host on
   the platform earned nothing while /v1/health read healthy.

   This module turns the three steps into ONE resumable plan
   derived from live chain state: reuse a prover that already fits
   the pair (the book's, or one this flow deployed before the
   browser died), else deploy; bind if unbound; publish if the
   book disagrees. Re-running after any interruption does only
   what is still missing, and it refuses outright when the pair
   can never work (a bound prover built for another ledger - only
   a new ledger fixes that).

   No DOM in this module: it probes, plans and encodes; the
   component drives the wallet and paints progress (the
   vaultmig.js division of labor). The planner is pure so
   test/admin-console.test.mjs can pin every branch.
   ============================================================ */
import { baseRpc, encCall, hexBig } from "../../js/core/chain.js";
import { CONTRACTS } from "../../js/gen/contract-artifacts.js";

const POT = CONTRACTS.EnclaveProofOfTime;
const DEP = CONTRACTS.EnclaveDeployments;
const REG = CONTRACTS.EnclaveRegistry;

const call = (to, data) => baseRpc("eth_call", [{ to, data }, "latest"]);
const asAddr = (word) => "0x" + (word || "").replace(/^0x/, "").slice(-40).padStart(40, "0");
const lc = (a) => (a || "").toLowerCase();
export const isZero = (a) => !a || /^0x0{40}$/i.test(a);

/* the ledger that proof of time needs (rev 9 grew provenUntil/setProver) and
   the registry it needs (schema 3 grew proofKey) */
export const MIN_LEDGER_SCHEMA = 9;
export const MIN_REGISTRY_SCHEMA = 3;

/* Does a prover at `addr` fit the (ledger, registry) pair? Soft on every read:
   a non-contract, a different contract, or a flaky RPC all come back as
   "does not fit" with the reason attached, never as a throw that blanks the
   panel. `code:false` is the only field the planner treats as "unreachable". */
export async function proverProbe(addr) {
  const out = { addr, code: false, ledger: null, registry: null, schema: null };
  if (!addr || isZero(addr)) return out;
  try {
    const code = await baseRpc("eth_getCode", [addr, "latest"]);
    if (!code || code === "0x") return out;
    out.code = true;
    const [l, r, s] = await Promise.all([
      call(addr, "0x" + POT.sel.deployments).then(asAddr).catch(() => null),
      call(addr, "0x" + POT.sel.registry).then(asAddr).catch(() => null),
      call(addr, "0x" + POT.sel.proofSchema).then((h) => Number(hexBig(h || "0x0"))).catch(() => null),
    ]);
    out.ledger = l; out.registry = r; out.schema = s;
  } catch { /* unreachable: code stays false */ }
  return out;
}

/* a probed prover fits when it points BACK at this ledger and reads the SAME
   registry the ledger reads (proof keys are looked up there) */
export const pairFits = (pair, ledger, registry) =>
  !!(pair && pair.code && pair.ledger && pair.registry
     && lc(pair.ledger) === lc(ledger) && lc(pair.registry) === lc(registry));

/* Everything the planner needs, read live (the console's cached S.dep can be
   a refresh behind the chain, and the binding is permanent - re-read). */
export async function proverState({ ledger, registry, schema }, bookProver, savedProver) {
  const [boundProver, proofFrom, regSchema] = await Promise.all([
    call(ledger, "0x" + DEP.sel.prover).then(asAddr).catch(() => null),
    call(ledger, "0x" + DEP.sel.proofRequiredFrom).then((h) => Number(hexBig(h || "0x0"))).catch(() => null),
    call(registry, "0x" + REG.sel.registrySchema).then((h) => Number(hexBig(h || "0x0"))).catch(() => null),
  ]);
  const [boundPair, bookPair, savedPair] = await Promise.all([
    proverProbe(boundProver), proverProbe(bookProver), proverProbe(savedProver)]);
  return { ledger, ledgerSchema: Number(schema), ledgerRegistry: registry, registrySchema: regSchema,
           boundProver, boundPair, bookProver, bookPair, savedProver, savedPair, proofFrom };
}

/* THE PLAN. Pure. Returns
     { ok, refuse, target, steps: subset of ["deploy","bind","book"], notes }
   - refuse names the reason nothing should be sent (and ok is false);
   - target is the prover the steps converge on (null until a deploy lands);
   - notes are what the operator should read before the first confirmation. */
export function planProverBind(s) {
  const notes = [];
  const fits = (pair) => pairFits(pair, s.ledger, s.ledgerRegistry);
  const short = (a) => a ? a.slice(0, 10) + "…" : "?";
  const bad = (refuse) => ({ ok: false, refuse, target: null, steps: [], notes });

  if (!(s.ledgerSchema >= MIN_LEDGER_SCHEMA))
    return bad(`the ledger is schema rev ${s.ledgerSchema}; proof of time needs rev ${MIN_LEDGER_SCHEMA} - deploy a current EnclaveDeployments first`);
  if (!s.ledgerRegistry || isZero(s.ledgerRegistry))
    return bad("the ledger's registry() reads as zero - not a rev-9+ ledger, or the RPC read failed; refresh and retry");
  if (s.registrySchema == null)
    return bad(`could not read registrySchema() at ${short(s.ledgerRegistry)} - a prover bound against an unverified registry is permanent; refresh and retry`);
  if (s.registrySchema < MIN_REGISTRY_SCHEMA)
    return bad(`the ledger reads registry ${short(s.ledgerRegistry)} at schema ${s.registrySchema}; proof keys need schema ${MIN_REGISTRY_SCHEMA} - redeploy registry + ledger as a pair first`);
  if (s.boundProver === null)
    return bad("could not read prover() from the ledger - refresh and retry");

  const bookMatches = (t) => !!s.bookProver && lc(s.bookProver) === lc(t);

  /* already bound: the only remaining job is the book key, and only if the
     binding is one this ledger can actually use */
  if (!isZero(s.boundProver)) {
    if (!fits(s.boundPair))
      return bad(`the ledger already has prover ${short(s.boundProver)} bound - built against ledger ${short(s.boundPair && s.boundPair.ledger)} / registry ${short(s.boundPair && s.boundPair.registry)}, not this pair. The binding is permanent: this ledger can never be proven; the fix is a new ledger + prover (scripts/deploy-deployments.mjs, then this flow).`);
    notes.push(`prover ${s.boundProver} is bound and fits this ledger`);
    if (bookMatches(s.boundProver)) { notes.push("the book's proofOfTime already points at it - nothing to do"); return { ok: true, refuse: null, target: s.boundProver, steps: [], notes }; }
    notes.push(s.bookProver ? `the book's proofOfTime is ${s.bookProver} - enclaves are sending checkpoints to a contract this ledger does not accept` : "the book has no proofOfTime key - running enclaves cannot find the prover");
    return { ok: true, refuse: null, target: s.boundProver, steps: ["book"], notes };
  }

  /* unbound: find a prover that fits, else deploy one */
  let target = null;
  if (s.bookProver && fits(s.bookPair)) {
    target = s.bookProver;
    notes.push(`the book's proofOfTime ${s.bookProver} already fits this ledger (deployed earlier, never bound) - reusing it`);
  } else if (s.bookProver) {
    notes.push(s.bookPair && s.bookPair.code
      ? `the book's proofOfTime ${s.bookProver} is built against ledger ${short(s.bookPair.ledger)}, not this one - every checkpoint the fleet signs reverts there ("not the runner"); it will be replaced`
      : `the book's proofOfTime ${s.bookProver} carries no readable contract - it will be replaced`);
  }
  if (!target && s.savedProver && fits(s.savedPair)) {
    target = s.savedProver;
    notes.push(`resuming: reusing prover ${s.savedProver}, deployed by an earlier run of this flow`);
  }
  const steps = [];
  if (!target) { steps.push("deploy"); notes.push(`a fresh EnclaveProofOfTime(${s.ledger}, ${s.ledgerRegistry}) will be deployed`); }
  steps.push("bind");
  if (!target || !bookMatches(target)) steps.push("book");
  if (s.proofFrom && Date.now() / 1000 >= s.proofFrom)
    notes.push(`proofRequiredFrom (${new Date(s.proofFrom * 1000).toISOString()}) is already LIVE: hosts earn nothing until the first checkpoint lands after the bind`);
  return { ok: true, refuse: null, target, steps, notes };
}

/* What the panel says about the prover TODAY (no wallet, no tx): the same
   facts the planner reads, reduced to one line + a severity. */
export function proverVerdict(s, now = Date.now() / 1000) {
  const live = !!s.proofFrom && now >= s.proofFrom;
  const when = s.proofFrom ? new Date(s.proofFrom * 1000).toLocaleString() : null;
  const fits = (pair) => pairFits(pair, s.ledger, s.ledgerRegistry);
  if (!isZero(s.boundProver)) {
    if (!fits(s.boundPair)) return { level: "stranded", text: `bound prover is built against another ledger/registry - permanent; this ledger can never be proven` };
    if (s.bookProver && lc(s.bookProver) === lc(s.boundProver)) return { level: "ok", text: "bound, published, and fits this ledger" };
    return { level: "warn", text: s.bookProver ? `bound, but the book's proofOfTime is a different contract - enclaves prove against the wrong one` : "bound, but not in the address book - enclaves cannot find it" };
  }
  const bookNote = s.bookProver
    ? (fits(s.bookPair) ? " The book's proofOfTime fits this ledger - it only needs binding."
       : s.bookPair && s.bookPair.code ? ` The book's proofOfTime ${s.bookProver.slice(0, 10)}… is built for ledger ${(s.bookPair.ledger || "?").slice(0, 10)}…, so every checkpoint reverts "not the runner".`
       : " The book's proofOfTime is not a readable contract.")
    : " The book has no proofOfTime key.";
  if (live) return { level: "stranded", text: `no prover bound and proof metering has been LIVE since ${when}: every host earns NOTHING for service since then, while claims/renews keep burning tenant balances.${bookNote}` };
  return { level: "warn", text: `no prover bound${when ? ` - hosts earn on held time until ${when}, then nothing` : ""}.${bookNote}` };
}

/* the creation tx for a prover bound to (ledger, registry) - the artifact's
   bytecode + the ABI-encoded constructor tuple, like the deploy cards */
export function proverDeployData(ledger, registry) {
  return POT.bytecode + encCall("", [{ t: "addr", v: ledger }, { t: "addr", v: registry }]).slice(2);
}
