/* ============================================================
   One-button rollout of a PAIRED contract revision.

   Some revisions cannot ship alone. Free self-hosting (ledger
   rev 12) reads a field that only a schema-4 EnclaveRegistry
   carries, and EnclaveProofOfTime holds BOTH of them as
   immutables — so moving either one means deploying all three,
   binding them, moving every deployment record across, re-seating
   the runner escrow the old ledger keeps, and pointing the book,
   in an order where a stop anywhere is survivable.

   Done by hand that is ~15 transactions across four panels with
   three chances to brick the fleet: point the book at a ledger
   whose registry is a revision older and EVERY claim reverts,
   fleet-wide, with nothing in the UI to say why. This module is
   the plan; admin-console.js drives the wallet and paints it.

   Every step is a DELTA against live chain state, so the button is
   safe to re-click: it re-probes, skips what is already true, and
   resumes at the first thing that is not. Nothing here is
   irreversible until the book flip, and the one destructive step
   (retiring the source) is deliberately left for a later click,
   after the fleet has actually followed.

   No DOM in this module — same rule as migrate.js.
   ============================================================ */
import { baseRpc, hexBig, encCall } from "../../js/core/chain.js";
import { CONTRACTS } from "../../js/gen/contract-artifacts.js";
import { encCallX } from "./migrate.js";

const lc = (a) => (a || "").toLowerCase();
const isZero = (a) => !a || /^0x0{40}$/i.test(a);
const call = (to, data) => baseRpc("eth_call", [{ to, data }, "latest"]);
const rdUintSoft = async (to, sel) => {
  try { const r = await call(to, "0x" + sel); return (!r || r === "0x") ? null : hexBig(r); } catch { return null; }
};
const rdAddrSoft = async (to, sel) => {
  try {
    const r = await call(to, "0x" + sel);
    if (!r || r === "0x") return null;
    return "0x" + r.replace(/^0x/, "").slice(-40);
  } catch { return null; }
};

/* The revision this console currently knows how to roll out. The numbers are
   the ones the CHECKED-IN artifacts compile to, which is why every deploy below
   is verified against them after it lands: a stale site build would otherwise
   deploy the previous revision and the run would happily continue, wiring a set
   that cannot serve. */
export const REV12 = {
  storeKey: "enclave_rev12",
  title: "Free self-hosting",
  ledgerRev: 12,
  registryRev: 4,
  summary: "A seller's own app on their own box runs for nothing: the ledger waives the host "
    + "component when the claiming enclave's registry-declared payout wallet is the deployment's owner.",
};

export const revOfLedger   = (a) => rdUintSoft(a, CONTRACTS.EnclaveDeployments.sel.deploymentsSchema).then((v) => Number(v ?? 0));
export const revOfRegistry = (a) => rdUintSoft(a, CONTRACTS.EnclaveRegistry.sel.registrySchema).then((v) => Number(v ?? 1));

/* Everything the run needs to decide what is already done. `saved` is the
   localStorage crumb trail from an interrupted run: addresses that exist on
   chain but that the book does not point at yet, and which would otherwise be
   redeployed (and paid for) on every re-click. */
export async function probeRev12(S, saved = {}) {
  const E = (S.book && S.book.entries) || {};
  const dSel = CONTRACTS.EnclaveDeployments.sel;
  const source = S.dep || null;
  if (!source) throw new Error("the address book has no `deployments` entry - there is nothing to roll forward from");

  // The source ledger's constructor arguments are the successor's: the same
  // USDC, the same payout wallet, the same price feed. Re-typing them by hand
  // is how a redeploy quietly changes where money lands.
  const usdc = await rdAddrSoft(source.addr, dSel.usdc);
  if (!usdc || isZero(usdc)) throw new Error("could not read the source ledger's USDC address - refusing to guess it");

  const pick = async (bookAddr, savedAddr, revOf, want) => {
    // the book's, if it is already the target revision (rollout already done)
    if (bookAddr && await revOf(bookAddr) >= want) return { addr: bookAddr, rev: await revOf(bookAddr), fromBook: true };
    // else one this flow deployed before the browser died
    if (savedAddr) { const r = await revOf(savedAddr).catch(() => 0); if (r >= want) return { addr: savedAddr, rev: r, fromBook: false }; }
    return { addr: null, rev: 0, fromBook: false };
  };

  const registry = await pick(E.registry, saved.registry, revOfRegistry, REV12.registryRev);
  const ledger   = await pick(E.deployments, saved.ledger, revOfLedger, REV12.ledgerRev);

  // A candidate ledger is only reusable if it is bound to the registry we are
  // actually shipping. Two half-finished runs could otherwise leave a rev-12
  // ledger pointing at a rev-3 registry — the exact mispairing that reverts
  // every claim — and the book flip would make it live.
  if (ledger.addr) {
    const boundReg = await rdAddrSoft(ledger.addr, dSel.registry);
    ledger.registry = boundReg;
    ledger.registryOk = !!registry.addr && lc(boundReg) === lc(registry.addr);
    ledger.prover = await rdAddrSoft(ledger.addr, dSel.prover);
    ledger.sealed = (await rdUintSoft(ledger.addr, dSel.importsSealed)) !== 0n;
    ledger.owner = await rdAddrSoft(ledger.addr, dSel.owner);
    ledger.proofFrom = await rdUintSoft(ledger.addr, dSel.proofRequiredFrom);
    if (!ledger.registryOk) { ledger.addr = null; ledger.rev = 0; }   // unusable: redeploy against the right registry
  }

  // The prover holds both as immutables, so it is only reusable when BOTH
  // match. It is also the cheapest of the three to redeploy.
  let prover = { addr: null };
  const cand = ledger.addr && !isZero(ledger.prover || "") ? ledger.prover : saved.prover;
  if (cand && ledger.addr && registry.addr) {
    const [pl, pr] = await Promise.all([
      rdAddrSoft(cand, CONTRACTS.EnclaveProofOfTime.sel.deployments),
      rdAddrSoft(cand, CONTRACTS.EnclaveProofOfTime.sel.registry),
    ]);
    if (lc(pl) === lc(ledger.addr) && lc(pr) === lc(registry.addr)) prover = { addr: cand };
  }

  const book = {
    registry: registry.addr && lc(E.registry) !== lc(registry.addr),
    deployments: ledger.addr && lc(E.deployments) !== lc(ledger.addr),
    proofOfTime: prover.addr && lc(E.proofOfTime) !== lc(prover.addr),
  };

  return {
    source: { addr: source.addr, rev: Number(source.schema || 0), owner: source.owner,
              usdc, payout: source.payout, feed: source.feed, proofFrom: source.proofFrom,
              registry: source.registry },
    registry, ledger, prover, book,
    // "nothing left to do": the book points at the new set and the source is
    // no longer the live ledger
    complete: !!(registry.addr && ledger.addr && prover.addr
                 && !book.registry && !book.deployments && !book.proofOfTime),
  };
}

/* The USDC the SOURCE holds as runner escrow — the money that cannot be
   imported (it is a real balance the old contract keeps) and that Back escrow
   re-seats from the operator's own wallet. Shown BEFORE anything is signed,
   because it is the only step of the run that spends money. */
export async function sourceEscrowTotal6(source) {
  const sel = CONTRACTS.EnclaveDeployments.sel;
  const n = Number(await rdUintSoft(source, sel.count) ?? 0);
  let total = 0n, ids = 0;
  for (let i = 0; i < n; i += 25) {
    const page = [];
    for (let k = i; k < Math.min(i + 25, n); k++) page.push(k);
    const held = await Promise.all(page.map(async (k) => {
      const id = await call(source, encCallX(sel.idAt, [{ t: "uint", v: k }]));
      const e = await call(source, encCallX(sel.earnOf, [{ t: "bytes32", v: id }]));
      const b = (e || "").replace(/^0x/, "");
      return b.length >= 128 ? hexBig("0x" + b.slice(64, 128)) : 0n;    // escrow6 = word 1
    }));
    for (const h of held) { total += h; if (h > 0n) ids++; }
  }
  return { total6: total.toString(), records: ids };
}

/* The wall a migration dies against without saying so. Public Base RPCs cap
   eth_estimateGas around 11M; past it the estimate errors, the wallet never
   receives a gas limit, and the transaction simply never broadcasts - no
   rejection, no revert, no console error. The run just stops on "confirm in
   your wallet…" forever. Checking the number OURSELVES before handing it over
   is the only way that failure becomes a sentence instead of a silence. */
export const MAX_TX_GAS = 10_000_000n;

/* null = could not estimate (a reverting call, or a flaky RPC). The caller
   treats that as "proceed and let the wallet decide": refusing to send on an
   unreadable estimate would make a transient RPC blip look like a dead button,
   which is the failure mode we are removing, not adding. */
export async function estimateGas(from, to, data) {
  try { return BigInt(await baseRpc("eth_estimateGas", [{ from, to, data }])); }
  catch { return null; }
}

/* ---- ready-to-send calldata for the steps that are not migrate/escrow ---- */

export const deployTx = (name, args) => CONTRACTS[name].bytecode + encCall("", args).slice(2);

export const setProverTx = (prover) =>
  encCall(CONTRACTS.EnclaveDeployments.sel.setProver, [{ t: "addr", v: prover }]);

export const setProofRequiredFromTx = (at) =>
  encCall(CONTRACTS.EnclaveDeployments.sel.setProofRequiredFrom, [{ t: "uint", v: String(at) }]);

export const retireTx = () => "0x" + CONTRACTS.EnclaveDeployments.sel.retire;

/* One book transaction for the whole set. setMany is not a nicety here: three
   separate flips leave a window in which the book names a rev-12 ledger and a
   schema-3 registry, and anything that reads the pair in that window wires
   itself to a combination that cannot claim. */
export function bookSetManyTx(pairs) {
  const encKey = (k) => { let h = ""; for (const ch of k) h += ch.charCodeAt(0).toString(16).padStart(2, "0"); return "0x" + h.padEnd(64, "0"); };
  return encCallX(CONTRACTS.EnclaveAddressBook.sel.setMany, [
    { t: "bytes32[]", v: pairs.map(([k]) => encKey(k)) },
    { t: "addr[]", v: pairs.map(([, a]) => a) },
  ]);
}
