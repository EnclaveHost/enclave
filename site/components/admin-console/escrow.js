/* ============================================================
   Escrow refunds for the admin console.

   What refund() pays: the runner's share of an OWNER's own
   fundings that this ledger still holds and no lease can still
   claim. The platform cut and the publisher fee left at funding
   time; runner credits left as they were earned; what remains is
   the tenant's, and refund(id) sends it back, zeroes the balance
   and deactivates the record (fund again to resume). It never
   reaches a live lease's reserve, and it never touches money a
   runner was credited.

   Why a panel: every second served with NO bound prover (the
   rev-13 strand, 2026-08-30 → 09-02) burned the tenant's balance
   without crediting the host, so the whole runner share of that
   time sat in escrow - $34 on the live ledger the day the prover
   was bound. refund() is owner-gated (the non-custodial anchor),
   so each owner wallet collects its own: this module scans every
   record, groups what is refundable by owner, and packs the
   connected wallet's records into multicall batches so the
   collection is one signature (delegatecall keeps msg.sender).
   Other owners are only REPORTED, so the operator knows which
   wallet to connect next.

   No DOM here: scan, summarize, simulate, encode - the component
   drives the wallet and paints (the vaultmig.js division).
   ============================================================ */
import { baseRpc, hexBig, decodeStructArray, DEP_SCHEMA } from "../../js/core/chain.js";
import { CONTRACTS } from "../../js/gen/contract-artifacts.js";
import { encCallX } from "./migrate.js";

const SEL = CONTRACTS.EnclaveDeployments.sel;
const PAGE = 50;
/* each refund moves USDC + a few SSTOREs (~90k gas): 12 per multicall keeps a
   batch far under public estimateGas ceilings (the migrate sweep's number) */
export const REFUND_BATCH = 12;
/* under a cent the gas outweighs the money and a refund deactivates the
   record for nothing - dust is reported, never selected */
export const DUST6 = 10_000n;

const lc = (a) => (a || "").toLowerCase();
const call = (to, data, from) => baseRpc("eth_call", [from ? { from, to, data } : { to, data }, "latest"], { emptyRetry: true });
const word = (hex, i) => (hex || "").replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const chunked = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/* Every record on `ledger` that still holds escrow or a refundable quote.
   Reads are chunked ten-wide so a 30-record ledger is ~a second, not a
   minute; `onProgress` gets a line per page. */
export async function scanRefundable(ledger, onProgress) {
  const say = (t) => { try { onProgress && onProgress(t); } catch {} };
  const total = Number(hexBig(await call(ledger, "0x" + SEL.count)));
  const all = [];
  for (let s = 0; s < total; s += PAGE) {
    all.push(...decodeStructArray(await call(ledger, encCallX(SEL.getPage, [{ t: "uint", v: s }, { t: "uint", v: PAGE }])), DEP_SCHEMA));
    say(`read ${Math.min(s + PAGE, total)}/${total} records`);
  }
  const rows = [];
  for (const page of chunked(all, 10)) {
    await Promise.all(page.map(async (r) => {
      const [rf, e] = await Promise.all([
        call(ledger, encCallX(SEL.refundableOf, [{ t: "bytes32", v: r.id }])),
        call(ledger, encCallX(SEL.earnOf, [{ t: "bytes32", v: r.id }])),
      ]);
      const refundable6 = hexBig(rf), escrow6 = hexBig("0x" + (word(e, 1) || "0"));
      if (refundable6 === 0n && escrow6 === 0n) return;
      rows.push({ id: r.id, owner: r.owner, appRef: r.appRef, active: !!r.active,
                  balance6: BigInt(r.balance6), rate: BigInt(r.rate), leaseUntil: Number(r.leaseUntil),
                  refundable6, escrow6 });
    }));
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));   // deterministic: the plan is re-derivable
  return { rows, total, scannedAt: Date.now() };
}

/* Pure. What the connected wallet can collect, what is too small to bother
   with, and what belongs to other wallets (by owner, largest first). */
export function refundSummary(rows, wallet, dust6 = DUST6) {
  const me = lc(wallet);
  const mine = [], dust = [], byOwner = new Map();
  for (const r of rows) {
    if (r.refundable6 === 0n) continue;
    if (me && lc(r.owner) === me) { (r.refundable6 >= dust6 ? mine : dust).push(r); continue; }
    const o = byOwner.get(lc(r.owner)) || { owner: r.owner, count: 0, total6: 0n };
    o.count++; o.total6 += r.refundable6; byOwner.set(lc(r.owner), o);
  }
  const sum = (a) => a.reduce((s, r) => s + r.refundable6, 0n);
  const others = [...byOwner.values()].sort((a, b) => (a.total6 > b.total6 ? -1 : a.total6 < b.total6 ? 1 : 0));
  return { mine, mine6: sum(mine), dust, dust6: sum(dust), others, others6: others.reduce((s, o) => s + o.total6, 0n) };
}

/* refund(id) for each id, packed into multicall batches - one wallet
   confirmation per batch. Ids are sorted so a re-run after a partial send
   builds the same batches. */
export function refundTxs(ids, batch = REFUND_BATCH) {
  const sorted = [...new Set(ids)].sort();
  return chunked(sorted, batch).map((c, i) => ({
    label: `refund · batch ${i + 1} (${c.length} record${c.length === 1 ? "" : "s"})`,
    ids: c,
    dataHex: encCallX(SEL.multicall, [{ t: "bytes[]", v: c.map((id) => encCallX(SEL.refund, [{ t: "bytes32", v: id }])) }]),
  }));
}

/* Dry-run one refund as the owner. A revert inside a multicall undoes the
   whole batch, so every id is simulated on its own first and the ones that
   would revert are dropped WITH their reason (a runner settling between the
   scan and the send is the usual one). */
export async function simulateRefund(ledger, id, from) {
  try {
    await call(ledger, encCallX(SEL.refund, [{ t: "bytes32", v: id }]), from);
    return { ok: true };
  } catch (e) {
    const m = (e && e.message) || String(e);
    const reason = (/reverted?(?: with reason string)?[:\s]+'?([^'\n]+)'?/i.exec(m) || [])[1] || m;
    return { ok: false, reason: reason.trim().slice(0, 80) };
  }
}
