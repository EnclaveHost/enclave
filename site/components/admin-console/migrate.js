/* ============================================================
   Contract-data migration engine for the admin console.

   Moves EVERYTHING out of a live contract into a freshly deployed
   import-capable revision: read the old contract's full state via
   its public getters, replay it verbatim through the new
   contract's owner-gated import functions, read the target back
   and diff it field-by-field, then permanently seal the imports.

   Encoding: the same minimal hand-rolled ABI codec philosophy as
   js/core/chain.js, extended here with dynamic arrays and tuple[]
   (the import functions take the EXACT structs the getters
   return, so one schema drives both the decode of the source and
   the encode of the import - pinned against viem in
   test/admin-console.test.mjs).

   No DOM in this module: it returns data + ready-to-send tx
   plans; the component drives the wallet and paints progress.
   ============================================================ */
import { baseRpc, pad32, encUint, encStr, encBytesTail, hexBig,
         decodeStructArray, decodeStringArray, DEP_SCHEMA, DEP_SCHEMA_V1, APP_SCHEMA, VER_SCHEMA } from "../../js/core/chain.js";
import { CONTRACTS } from "../../js/gen/contract-artifacts.js";

/* ---- codec: tuples + arrays on top of chain.js's word encoders ---- */

export function encTuple(schema, obj) {
  let off = schema.length * 32; const heads = [], tails = [];
  for (const f of schema) {
    const v = obj[f.k];
    if (f.t === "str") { const e = encStr(String(v ?? "")); heads.push(encUint(off)); off += e.words * 32; tails.push(e.body); }
    else if (f.t === "uint") heads.push(encUint(v ?? 0));
    else if (f.t === "bool") heads.push(encUint(v ? 1 : 0));
    else heads.push(pad32(String(v || "0x0").replace(/^0x/, "")));   // addr | bytes32
  }
  const body = heads.join("") + tails.join("");
  return { body, words: body.length / 64 };
}

export function encTupleArr(schema, rows) {
  let off = rows.length * 32; const heads = [], tails = [];
  for (const r of rows) { const e = encTuple(schema, r); heads.push(encUint(off)); off += e.words * 32; tails.push(e.body); }
  const body = encUint(rows.length) + heads.join("") + tails.join("");
  return { body, words: body.length / 64 };
}

/* encCall extended with array/tuple args:
   {t:"tuple[]", schema, v:[objs]} · {t:"str[]"|"bytes[]"|"uint[]"|"bool[]"|"addr[]"|"bytes32[]", v}
   (any uintN[] uses "uint[]" - the width only matters to the selector, which
   comes from viem via the artifacts). Scalars as in chain.js encCall. */
export function encCallX(selector, args) {
  let off = args.length * 32; const heads = [], tails = [];
  const dyn = (body) => { heads.push(encUint(off)); off += (body.length / 64) * 32; tails.push(body); };
  for (const a of args) {
    if (a.t === "tuple[]") dyn(encTupleArr(a.schema, a.v).body);
    else if (a.t === "str[]" || a.t === "bytes[]") {
      let eoff = a.v.length * 32; const eheads = [], etails = [];
      for (const s of a.v) {
        const body = a.t === "str[]" ? encStr(String(s ?? "")).body : encBytesTail(s || "0x");
        eheads.push(encUint(eoff)); eoff += (body.length / 64) * 32; etails.push(body);
      }
      dyn(encUint(a.v.length) + eheads.join("") + etails.join(""));
    } else if (a.t && a.t.endsWith("[]")) {
      const words = a.v.map((v) => a.t === "uint[]" ? encUint(v) : a.t === "bool[]" ? encUint(v ? 1 : 0) : pad32(String(v).replace(/^0x/, "")));
      dyn(encUint(a.v.length) + words.join(""));
    } else if (a.t === "str") { const e = encStr(a.v); heads.push(encUint(off)); off += e.words * 32; tails.push(e.body); }
    else if (a.t === "uint") heads.push(encUint(a.v));
    else if (a.t === "bool") heads.push(encUint(a.v ? 1 : 0));
    else heads.push(pad32(String(a.v).replace(/^0x/, "")));
  }
  return "0x" + selector + heads.join("") + tails.join("");
}

/* ---- low-level reads ---- */

/* Every read here feeds an IMPORT, so a silently empty response is the one
   thing this file must never tolerate. `0x` from a lagging pool member is not a
   zero - but word()/wNum() turn it into one, and that zero is indistinguishable
   from real data:
     - count -> the target reads as EMPTY, so the delta re-plans records it
       already holds (importDeployments then reverts "exists") and verify
       reports every record missing;
     - feeOf/earnOf/capOf -> the side mappings read as 0, so verify reports
       phantom mismatches AND, far worse, a source read can migrate a
       fee-bearing record with fee 0, silently cutting its publisher off.
   So: retry across the pool (emptyRetry), then FAIL LOUDLY rather than guess.
   Callers that legitimately expect a revert (revision sniffs) catch that
   separately - a revert and an empty answer are different facts. */
const call = async (to, data) => {
  const r = await baseRpc("eth_call", [{ to, data }, "latest"], { emptyRetry: true });
  if (!r || r === "0x")
    throw new Error(`empty response from ${to.slice(0, 10)}… - an RPC is lagging behind this contract, not a zero value. Retry in a moment.`);
  return r;
};
const isRevert = (e) => /revert/i.test((e && e.message) || "");
const word = (hex, i) => (hex || "").replace(/^0x/, "").slice(i * 64, i * 64 + 64);
const wNum = (hex, i) => Number(hexBig("0x" + (word(hex, i) || "0")));
const wAddr = (hex, i) => "0x" + word(hex, i).slice(24);
const wB32 = (hex, i) => "0x" + word(hex, i);

/* has the target got the import surface, and is it still open?
   old revisions revert on the selector -> "not import-capable". */
export async function importState(target, contractName) {
  try {
    const r = await call(target, "0x" + CONTRACTS[contractName].sel.importsSealed);
    return { capable: true, sealed: hexBig(r) !== 0n };
  } catch (e) {
    // A revert genuinely means "no import surface here". Anything else is an
    // RPC problem, and reporting THAT as "not import-capable" would send an
    // operator off to deploy a second target they do not need.
    if (isRevert(e)) return { capable: false };
    throw e;
  }
}

/* Runner escrow is the one thing a migration CANNOT import: it is real USDC
   held by the source contract, and the source keeps it (its operators stay able
   to withdraw what they earned there, forever). So a freshly migrated ledger
   holds balances it cannot pay anyone out of - every record arrives with
   escrow6 = 0, and until it is re-backed:
     - _creditRunner caps every credit at escrow6, so a seller serving a
       migrated deployment earns NOTHING; and
     - (rev >= 10) refundableOf is 0, so the owner's Cancel button cannot pay.
   sealImports does not close this - fundEscrow stays open forever - but the
   ownerEscrow6 ATTRIBUTION does close with it: while imports are open a
   platform fundEscrow credits the owner (it is re-seating money the owner
   already paid on the source), and once sealed it does not. Back the escrow
   BEFORE sealing or the records are permanently un-refundable.

   Required backing per record is what _splitFunding would have escrowed for the
   balance it still carries: ceil(balance6 * rate6 / rate), read off the TARGET
   (its rate6 is what its own credits will use), minus whatever it already
   holds. Records that are inactive or still have rate6 = 0 are reported as
   skipped rather than silently dropped - fundEscrow would revert on both. */
export async function escrowPlan(target) {
  const sel = CONTRACTS.EnclaveDeployments.sel;
  const total = wNum(await call(target, "0x" + sel.count), 0);
  const rows = [];
  for (let s = 0; s < total; s += PAGE)
    rows.push(...decodeStructArray(await call(target, encCallX(sel.getPage, [{ t: "uint", v: s }, { t: "uint", v: PAGE }])), DEP_SCHEMA));
  const items = [], skipped = [];
  for (const page of chunked(rows, 10)) {
    await Promise.all(page.map(async (r) => {
      const e = await call(target, encCallX(sel.earnOf, [{ t: "bytes32", v: r.id }]));
      const rate6 = hexBig("0x" + (word(e, 0) || "0"));
      const held = hexBig("0x" + (word(e, 1) || "0"));
      const bal = BigInt(r.balance6), rate = BigInt(r.rate);
      if (rate6 === 0n) return void skipped.push({ id: r.id, why: "no runner rate - grant one during Migrate first" });
      if (!r.active) return void skipped.push({ id: r.id, why: "inactive - fundEscrow requires an active record" });
      if (bal === 0n || rate === 0n) return;                       // nothing to back
      const want = (bal * rate6 + (rate - 1n)) / rate;             // ceil, exactly like _splitFunding
      if (want > held) items.push({ id: r.id, amount6: (want - held).toString() });
    }));
  }
  items.sort((a, b) => (a.id < b.id ? -1 : 1));                    // deterministic order for a resumable run
  const totalNeeded = items.reduce((s, x) => s + BigInt(x.amount6), 0n);
  const txs = chunked(items, CHUNK.escrow).map((c, i) => ({
    label: `fundEscrow · batch ${i + 1} (${c.length})`,
    gas: 60_000 + 90_000 * c.length,
    dataHex: encCallX(CONTRACTS.EnclaveDeployments.sel.multicall, [{ t: "bytes[]", v: c.map((x) =>
      encCallX(sel.fundEscrow, [{ t: "bytes32", v: x.id }, { t: "uint", v: x.amount6 }])) }]),
  }));
  return { items, skipped, total6: totalNeeded.toString(), txs: txs.length === 1 && items.length === 1
    ? [{ label: `fundEscrow · 1 record`, gas: 150_000,
         dataHex: encCallX(sel.fundEscrow, [{ t: "bytes32", v: items[0].id }, { t: "uint", v: items[0].amount6 }]) }]
    : txs };
}

/* ERC-20 approve(address,uint256) - the console's only non-project-contract
   call. Same selector site/js/core/fund.js uses, pinned against viem in
   test/admin-console.test.mjs. fundEscrow pulls with transferFrom, so the
   target needs an allowance before the batches above will land. */
export const APPROVE_SEL = "095ea7b3";
export function approveTx(spender, amount6) {
  return encCallX(APPROVE_SEL, [{ t: "addr", v: spender }, { t: "uint", v: String(amount6) }]);
}

/* ---- pre-migration refund sweep (SOURCE-side, before the snapshot) --------
   "Refund then migrate": every record the CONNECTED wallet owns gets
   suspended and refunded ON THE SOURCE, so it migrates with a zero balance -
   nothing for Back escrow to front, and nothing left owner-pullable on a
   retired ledger (a rev-10 source keeps a live refund() forever, so any
   balance re-backed on the target in the import window would be collectable
   TWICE). Third-party records cannot be swept - refund() is owner-gated, and
   that gate is the non-custodial anchor - so they are only REPORTED: their
   owners collect on the source themselves.

   Two batched phases, both idempotent and re-plannable from live state:
     1. suspend - setActive(false) on the wallet's active records, so the
        fleet tears down and releases each lease (its reserved tail frees
        back to refundable within ~a pass);
     2. refund  - refund(id) for every record refundable RIGHT NOW.
   Owner money still lease-reserved (min(ownerEscrow6, escrow6) beyond the
   current quote) is returned as `reserved`: re-scan after the releases land
   and the next refund batch collects the tails. Plans go stale the moment a
   runner settles or claims - a reverted batch just means re-scan and resend. */
export async function refundSweepPlan(source, wallet) {
  const sel = CONTRACTS.EnclaveDeployments.sel;
  const rev = await depRevOf(source);
  if (rev < 10) throw new Error(`this ledger predates refunds (deploymentsSchema ${rev} < 10) - nothing to sweep`);
  const me = (wallet || "").toLowerCase();
  if (!me) throw new Error("no wallet connected - the sweep can only sign for records this wallet owns");
  // rev 11: a RETIRED ledger opens refund() to ANY caller - still paying each
  // record's OWNER - so the sweep widens to EVERY record, and the suspend
  // phase disappears (no claim can land on a retired ledger; leases lapse on
  // their own within a quantum). This is how a cutover with real users works:
  // fleet repoints, retire(), one permissionless sweep sends everyone home.
  let isRetired = false;
  if (rev >= 11) isRetired = hexBig(await call(source, "0x" + sel.retired)) !== 0n;
  const total = wNum(await call(source, "0x" + sel.count), 0);
  const rows = [];
  for (let s = 0; s < total; s += PAGE)
    rows.push(...decodeStructArray(await call(source, encCallX(sel.getPage, [{ t: "uint", v: s }, { t: "uint", v: PAGE }])), DEP_SCHEMA));
  const now = Math.floor(Date.now() / 1000);
  const mine = isRetired ? rows : rows.filter((r) => r.owner.toLowerCase() === me);
  const suspend = [], refunds = [], reserved = [], refundOwners = new Set();
  let refundable6 = 0n, reserved6 = 0n;
  for (const page of chunked(mine, 10)) {
    await Promise.all(page.map(async (r) => {
      const [rf, oe, e] = await Promise.all([
        call(source, encCallX(sel.refundableOf, [{ t: "bytes32", v: r.id }])),
        call(source, encCallX(sel.ownerEscrow6, [{ t: "bytes32", v: r.id }])),
        call(source, encCallX(sel.earnOf, [{ t: "bytes32", v: r.id }])),
      ]);
      const quote = hexBig(rf), own = hexBig(oe), held = hexBig("0x" + (word(e, 1) || "0"));
      // setActive stays owner-gated even when retired - and is pointless there
      if (!isRetired && r.active && (BigInt(r.balance6) > 0n || Number(r.leaseUntil) > now)) suspend.push(r.id);
      if (quote > 0n) { refunds.push(r.id); refundable6 += quote; refundOwners.add(r.owner.toLowerCase()); }
      // owner money the ledger still holds beyond today's quote = the lease
      // reserve (or an unsettled lapse); it frees at release/settle
      const stuck = (own < held ? own : held) - quote;
      if (stuck > 0n) { reserved.push({ id: r.id, amount6: stuck.toString(), leaseUntil: Number(r.leaseUntil) }); reserved6 += stuck; }
    }));
  }
  suspend.sort(); refunds.sort();                      // deterministic order for a resumable run
  const suspendTxs = chunked(suspend, CHUNK.suspend).map((c, i) => ({
    label: `setActive(false) · batch ${i + 1} (${c.length})`,
    dataHex: encCallX(sel.multicall, [{ t: "bytes[]", v: c.map((id) =>
      encCallX(sel.setActive, [{ t: "bytes32", v: id }, { t: "bool", v: false }])) }]),
  }));
  const refundTxs = chunked(refunds, CHUNK.refund).map((c, i) => ({
    label: `refund · batch ${i + 1} (${c.length})`,
    dataHex: encCallX(sel.multicall, [{ t: "bytes[]", v: c.map((id) =>
      encCallX(sel.refund, [{ t: "bytes32", v: id }])) }]),
  }));
  // funded records this wallet CANNOT sweep (un-retired ledgers only): their
  // owners self-refund here, or retirement opens them to the sweep
  const othersFunded = isRetired ? 0
    : rows.filter((r) => r.owner.toLowerCase() !== me && BigInt(r.balance6) > 0n).length;
  return { mine: mine.length, suspend, refunds, reserved, othersFunded,
           retired: isRetired, refundOwners: refundOwners.size,
           refundable6: refundable6.toString(), reserved6: reserved6.toString(),
           suspendTxs, refundTxs };
}

/* ---- per-kind engines ----
   Each kind: { label, contractName, bookKey,
                read(source) -> data, counts(data) -> string,
                plan(data) -> [{label, dataHex}]  (txs to send TO the target),
                verify(data, target) -> {total, ok, bad: [labels]} } */

const PAGE = 50;
// Keep each migration tx SMALL. A large multicall (tens of KB calldata / >10M
// gas) gets SIGNED and handed back a tx hash, but wallets/RPCs silently DROP it
// at broadcast - it never lands, so the console sits on "sent … waiting" while
// the receipt never appears. Bound every packed tx on BOTH axes (see packPlan),
// and size-chunk versions since their `config` blob can be up to 4 KB each.
const CHUNK = { deployments: 6, apps: 10, fees: 40, escrow: 12,     // fees: 3 words + 1 SSTORE + event per id - cheap
                suspend: 60, refund: 12 };             // escrow/refund: each moves USDC + SSTOREs, ~90k gas;
                                                       // suspend: one SSTORE + event, cheap
const VER_TX_BYTES = 6 * 1024;   // max calldata for a single importVersions call
// ...and its gas twin. 4M leaves packPlan room to still batch two version
// calls under its 9M budget, while keeping any SINGLE call far enough under
// the ~11M estimateGas ceiling that it broadcasts even unpacked.
const VER_TX_GAS = 4_000_000;

/* What importing ONE record actually costs. A deployment is mostly STRINGS -
   appRef, ports, and the deployment-options envelope in configCid, which rev 5
   widened from CID-sized (100 bytes) to 4096 - and a cold SSTORE is 20k per
   32-byte word, so a 4 KB envelope is ~3M gas on its own. A flat per-record
   figure is therefore not a rough estimate, it is a different number entirely:
   the 450k this used to assume is ~7x under for an envelope-carrying record,
   which packed six of them into one 15.7M-gas transaction. That is over the
   ~11M ceiling below, where the wallet never broadcasts and reports nothing -
   the failure this whole budget exists to avoid.

   Calibrated on Base against the live ledger (n = 1,2,3,4,6 records,
   80..3990 string bytes each): gas ~= 12k + 270k*n + 730*bytes, within 0.2%
   across that range. Carries a 20% margin on top, because the number that
   matters is never being UNDER the real cost. */
const strBytes = (v) => new TextEncoder().encode(String(v ?? "")).length;
/* Per-record and per-byte cost, MEASURED against a live empty catalog with
   eth_estimateGas rather than reasoned about (importApps at n = 1, 4, 8:
   0.27M / 1.33M / 2.75M for 52 / 694 / 1574 string bytes, which solves to
   243k*n + 510*bytes within 0.4%). The previous 270k + 730 carried a 1.2x
   margin on top and came out ~1.43x high, and over-estimating is not free
   here: the planner packs on these numbers, so inflated ones mean smaller
   batches and MORE hardware-wallet confirmations. Keep a 15% margin, no more,
   and let the console's pre-send eth_estimateGas be the real safety net. */
const G_PER_RECORD = 280_000, G_PER_BYTE = 590;
// ...and these are the CATALOG's numbers only. recordImportGas below keeps its
// own 270k/730, measured separately against the live LEDGER — a Deployment is a
// different struct in a different contract, and one path's calibration is not
// evidence about another's.
export const recordImportGas = (d) =>
  Math.ceil(1.2 * (270_000 + 730 * (strBytes(d.appRef) + strBytes(d.ports) + strBytes(d.configCid))));

/* The same calibrated model for a catalog VERSION, and for the same reason.
   This path used a flat 300k per version, which is the exact mistake the note
   above describes: a Version is mostly STRINGS — cid, label, ports, and a
   config blob the record still allows up to 4096 bytes — so a config-carrying
   version is ~3.3M gas, over 10x the flat figure. Chunking bounded CALLDATA
   (6 KB) but reported that flat number to packPlan, which then folded four
   such calls into one multicall costing ~20M: signed, handed back a hash, and
   silently dropped at broadcast. Live symptom, 2026-08-10, migrating 32 apps /
   351 versions: "[1/24] multicall · 4 calls (importVersions) — sent … waiting"
   forever. Under-reporting gas here does not make a tx cheap, it makes it
   un-broadcastable. */
/* And for an APP record. Same model, same reason, and this one bit hardest:
   apps carry slug + name + a description up to 500 bytes, so a real app is
   ~600k gas against the flat 250k this used to assume — 2.8x under for a batch
   of ten. That was survivable while the WALLET estimated the gas, and became
   fatal the moment the console started passing an explicit limit: the limit was
   simply too small, the batch would have run out of gas, and MetaMask's
   smart-transaction simulation cancelled it before broadcast
   (FAILED_WOULD_REVERT). Which then looked exactly like an RPC refusing an
   oversized transaction, and sent me chasing a size ceiling that was not there. */
export const appImportGas = (a) =>
  Math.ceil(G_PER_RECORD + G_PER_BYTE * (strBytes(a.slug) + strBytes(a.name) + strBytes(a.description)));

export const versionImportGas = (v) =>
  Math.ceil(G_PER_RECORD + G_PER_BYTE * (strBytes(v.cid) + strBytes(v.version)
                                         + strBytes(v.ports) + strBytes(v.config)));

/* Split by COST, not by count. `max` still caps a batch (a sanity bound on
   calldata and on how much one failed confirmation costs), but the gas budget
   is what actually decides, so a batch of small records stays big and a batch
   of envelope-carrying ones shrinks to two. */
function chunkByGas(items, gasOf, budget, max) {
  if (!items.length) return [];
  const out = [[]];
  let used = 0;
  for (const it of items) {
    const g = gasOf(it);
    const cur = out[out.length - 1];
    if (cur.length && (used + g > budget || cur.length >= max)) { out.push([]); used = 0; }
    out[out.length - 1].push(it);
    used += g;
  }
  return out;
}

/* -- deployments -- */
// Struct-schema revision sniff (same idea as the catalog's): rev-1 sources
// have no deploymentsSchema getter (the call reverts) and their Deployment
// tuples carry the removed sshPubKey string - decode those with the v1
// schema and drop the field, so the import always encodes the rev-2 tuple.
async function depRevOf(addr) {
  const sel = CONTRACTS.EnclaveDeployments.sel;
  // ONLY a revert means "rev 1" (the getter does not exist there). An empty or
  // failed read must propagate: sniffing rev 1 by accident decodes every record
  // with the V1 schema, which silently shifts every field.
  try { return wNum(await call(addr, "0x" + sel.deploymentsSchema), 0) || 1; }   // word 0 of the return
  catch (e) { if (isRevert(e)) return 1; throw e; }
}
async function readDeployments(source) {
  const sel = CONTRACTS.EnclaveDeployments.sel;
  const rev = await depRevOf(source);
  const schema = rev >= 2 ? DEP_SCHEMA : DEP_SCHEMA_V1;
  const total = wNum(await call(source, "0x" + sel.count), 0);
  let rows = [];
  for (let s = 0; s < total; s += PAGE)
    rows.push(...decodeStructArray(await call(source, encCallX(sel.getPage, [{ t: "uint", v: s }, { t: "uint", v: PAGE }])), schema));
  rows = rows.map(({ sshPubKey, ...r }) => r);
  // Publisher-fee snapshots live in a SIDE MAPPING (rev >= 4), invisible to
  // getPage - read feeOf(id) per row and ride it along as `fee` (a non-schema
  // key: tuple encodes and depCmp ignore it). Skipping this on a fee-bearing
  // record would migrate its rate intact but silently redirect the publisher's
  // cut to payout - and runners fail closed on an under-declared fee, so the
  // record would strand unclaimable on the new ledger.
  if (rev >= 4) {
    for (const page of chunked(rows, 10)) {
      await Promise.all(page.map(async (r) => {
        const f = await call(source, encCallX(sel.feeOf, [{ t: "bytes32", v: r.id }]));
        r.fee = { recipient: wAddr(f, 0), rate6: hexBig("0x" + (word(f, 1) || "0")).toString() };
      }));
    }
  }
  // Runner-rate snapshots are another side mapping (rev >= 7), same story as
  // fees: invisible to getPage, so read earnOf(id) per row and ride the rate
  // along as `earn` (non-schema key). Only the RATE migrates - escrow6 is real
  // USDC held by the source (re-back the target with fundEscrow) and
  // creditedUntil dies with the source's leases. Skipping this on a
  // rate-bearing record would silently stop paying its runner on the new
  // ledger.
  if (rev >= 7) {
    for (const page of chunked(rows, 10)) {
      await Promise.all(page.map(async (r) => {
        const e = await call(source, encCallX(sel.earnOf, [{ t: "bytes32", v: r.id }]));
        // escrow6 rides along READ-ONLY: it cannot be imported (it is real USDC
        // held by the source), but the escrow step below needs to show what the
        // source is holding so an operator can see what they are re-backing.
        r.earn = { rate6: hexBig("0x" + (word(e, 0) || "0")).toString(),
                   escrow6: hexBig("0x" + (word(e, 1) || "0")).toString() };
      }));
    }
  }
  // Rate caps: a third side mapping (rev >= 8). A rev-8 TARGET defaults every
  // imported record's cap to the rate it arrives with, which is exactly right
  // when migrating FROM an older ledger (same economics, no dearer enclave can
  // take it). From a rev-8 source the real caps must ride along instead, or an
  // owner's deliberately roomy ceiling would quietly tighten to its rate.
  if (rev >= 8) {
    for (const page of chunked(rows, 10)) {
      await Promise.all(page.map(async (r) => {
        const c = await call(source, encCallX(sel.capOf, [{ t: "bytes32", v: r.id }]));
        r.cap6 = hexBig("0x" + (word(c, 0) || "0")).toString();
      }));
    }
  }
  return rows;
}
/* The runner rate a GRANT gives a record whose source had none - the ledger's
   own _snapRunnerRate, runnerBps of the rate minus the publisher fee. Shared by
   plan() and verify() deliberately: a grant is a difference from the source
   that verify must EXPECT, and if the two computed it separately they could
   disagree and leave a correct migration permanently unable to verify clean
   (which blocks Seal). Returns null when nothing would be granted. */
function grantedRate6(d, runnerBps) {
  if (!runnerBps) return null;
  if (d.earn && d.earn.rate6 !== "0") return null;      // it has one; nothing to grant
  const fee6 = BigInt((d.fee && d.fee.rate6) || 0);
  const r6 = ((BigInt(d.rate) - fee6) * BigInt(runnerBps)) / 10000n;
  return r6 > 0n ? r6.toString() : null;
}

const depKey = (d) => d.id;
/* An imported record arrives with NO HOST — the lease is stripped right here —
   so its `rate` must be what create() gives a hostless record: the CAP.
   create() says it outright ("No host has priced this yet, so the working rate
   is the CAP: the most it could ever cost"), and carrying a stale one across is
   wrong in both directions. It matters most for a FREE self-hosted deployment,
   whose rate is 0 because its owner's own enclave is serving it: import that 0
   and the record lands willing to pay nothing, so when that host goes away no
   paid enclave can take it — the deployment is stranded on a host that no
   longer exists. (importDeployments refuses rate 0 outright for a related
   reason, which is how this surfaced: 4 of 17 live records.)
   A record with no cap AND no rate has expressed no willingness to pay at all;
   there is nothing to substitute, and it is caught before planning. */
const depClean = (d) => ({ ...d, runner: "0x" + "0".repeat(64), runnerOperator: "0x" + "0".repeat(40), leaseUntil: 0,
  rate: BigInt(d.rate || 0) === 0n && BigInt(d.cap6 || 0) > 0n ? d.cap6 : d.rate });
const depCmp = (a, b) => DEP_SCHEMA.every((f) => ["runner", "runnerOperator", "leaseUntil"].includes(f.k)
  || String(a[f.k]).toLowerCase() === String(b[f.k]).toLowerCase());

/* -- catalog -- */
// Struct-schema revision sniff: rev-4 catalogs' VERSION tuples carry
// `config`; a source without the marker getter (call reverts) is rev 2;
// rev 3 (the retired app-level-config layout, 0xa036d5e8…) has config-LESS
// versions - decode both pre-4 shapes WITHOUT config and default the field,
// so the migration reads clean and the import encodes the full rev-4 tuple.
// (Rev-3 App tuples carry a trailing app-level config; decoding them with
// the 9-field APP_SCHEMA is a safe prefix read - that field is dropped,
// deliberately: nothing in rev 4 stores app-level config.)
const VER_SCHEMA_V2 = VER_SCHEMA.filter((f) => f.k !== "config");
async function catalogRevOf(addr) {
  const sel = CONTRACTS.EnclaveAppCatalog.sel;
  // wNum's 2nd arg is the WORD INDEX (the return is one word at index 0) -
  // it was 2, so this always fell back to rev 2 and readCatalog prefix-
  // decoded rev-4 versions config-LESS: a silent config drop the verify pass
  // couldn't see (both sides dropped it). Deployments hit the loud version
  // of the same bug (mid-struct field -> every row garbled, 0/N verify).
  // Same rule as depRevOf: only a REVERT means "the getter isn't there" (rev
  // 2). An empty read must propagate rather than silently pick a schema.
  try { return wNum(await call(addr, "0x" + sel.catalogSchema), 0) || 2; }
  catch (e) { if (isRevert(e)) return 2; throw e; }
}
async function readCatalog(source) {
  const sel = CONTRACTS.EnclaveAppCatalog.sel;
  const rev = await catalogRevOf(source);
  const verSchema = rev >= 4 ? VER_SCHEMA : VER_SCHEMA_V2;
  const total = wNum(await call(source, "0x" + sel.appCount), 0);
  const apps = [];
  for (let s = 0; s < total; s += PAGE)
    apps.push(...decodeStructArray(await call(source, encCallX(sel.getAppsPage, [{ t: "uint", v: s }, { t: "uint", v: PAGE }])), APP_SCHEMA));
  for (const a of apps) {
    a.versions = [];
    for (let s = 0; s < a.versionCount; s += PAGE)
      a.versions.push(...decodeStructArray(await call(source, encCallX(sel.getVersionsPage, [{ t: "bytes32", v: a.appId }, { t: "uint", v: s }, { t: "uint", v: PAGE }])), verSchema));
    if (rev < 4) for (const v of a.versions) v.config = "";
    // Publisher fees live in a SIDE MAPPING (rev >= 5), invisible to
    // getVersionsPage - read versionFee per version and ride it along as
    // `fee6` (a non-schema key: tuple encodes and verCmp ignore it). Same
    // story as the ledger's feeOf: skipping this would migrate a paid app's
    // versions intact but silently zero its fee - every future deployment of
    // it would stop paying the publisher.
    if (rev >= 5) {
      for (const batch of chunked(a.versions.map((v, i) => i), 10)) {
        await Promise.all(batch.map(async (i) => {
          const f = await call(source, encCallX(sel.versionFee, [{ t: "bytes32", v: a.appId }, { t: "uint", v: i }]));
          a.versions[i].fee6 = hexBig((f && f !== "0x") ? f : "0x0").toString();
        }));
      }
    } else for (const v of a.versions) v.fee6 = "0";
    // Config CIDs are a SIDE MAPPING too (rev >= 7), and dropping one is worse
    // than dropping a fee: the version would migrate with its on-chain ROUTING
    // MANIFEST intact and its actual config gone, so it would still deploy and
    // still look healthy while serving the manifest as its config. One batched
    // read for the whole history, carried as the non-schema key `cfgCid`.
    if (rev >= 7) {
      const cids = decodeStringArray(await call(source, encCallX(sel.versionConfigCids, [{ t: "bytes32", v: a.appId }])));
      a.versions.forEach((v, i) => { v.cfgCid = cids[i] || ""; });
    } else for (const v of a.versions) v.cfgCid = "";
  }
  return apps;
}
const appCmp = (a, b) => APP_SCHEMA.every((f) => String(a[f.k]).toLowerCase() === String(b[f.k]).toLowerCase());
const verCmp = (a, b) => VER_SCHEMA.every((f) => String(a[f.k]).toLowerCase() === String(b[f.k]).toLowerCase());

const chunked = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
// rough encoded size (bytes) of one Version tuple: fixed head + each dynamic
// string padded up to a 32-byte word (slight over-estimate, which is safe).
const verSize = (v) => 384 + ["cid", "version", "ports", "config"]
  .reduce((s, k) => s + 32 + Math.ceil(String(v[k] || "").length / 32) * 32, 0);
// split `arr` so each chunk's summed sizeOf stays under maxBytes; a single item
// over the cap still gets its own chunk (callers keep items well under it).
const chunkBySize = (arr, maxBytes, sizeOf) => {
  const out = []; let cur = [], b = 0;
  for (const it of arr) { const s = sizeOf(it);
    if (cur.length && b + s > maxBytes) { out.push(cur); cur = []; b = 0; }
    cur.push(it); b += s; }
  if (cur.length) out.push(cur);
  return out;
};
// Split on BOTH axes at once. Bytes alone is not enough for versions: 6 KB of
// strings is ~4.4M gas on its own, so a chunk can be well inside the calldata
// cap and still be the thing that blows the broadcast ceiling.
const chunkBySizeAndGas = (arr, maxBytes, sizeOf, maxGas, gasOf) => {
  const out = []; let cur = [], b = 0, g = 0;
  for (const it of arr) {
    const s = sizeOf(it), q = gasOf(it);
    if (cur.length && (b + s > maxBytes || g + q > maxGas)) { out.push(cur); cur = []; b = 0; g = 0; }
    cur.push(it); b += s; g += q;
  }
  if (cur.length) out.push(cur);
  return out;
};

/* Fold the planned import calls into multicall(bytes[]) transactions so a
   whole migration usually rides ONE wallet confirmation. Greedy packing by
   rough per-call gas estimates against a per-tx budget (well under Base's
   block limit; the wallet still estimates the real number before signing).
   Inner auth is untouched - multicall delegatecalls self, msg.sender holds. */
// The binding limit is GAS, not size. It USED to be the ~11M eth_estimateGas
// ceiling on public Base RPCs — above that the estimate errors, the wallet gets
// no limit, and the tx is silently dropped at broadcast. The console now sends
// these with an EXPLICIT gas limit (the number computed right here), so nothing
// estimates and that ceiling no longer applies. What binds instead is Base's
// real block limit, 400M, and how much of a block a builder will give one tx.
//
// This matters for one human reason: a migration is signed on a hardware
// wallet, one confirmation per transaction. At the old 9M budget a 351-version
// catalog (509M gas, measured) came to 56 confirmations, which is not a thing a
// person can be asked to do. 60M is ~15% of a Base block — blocks run ~28M used
// against a 400M limit, so this is a large transaction but not an exotic one —
// and it brings that down to roughly a dozen.
//
// If a batch this size is ever refused by a relay, it is now LOUD: waitReceipt
// tells a dropped tx from a slow one and reports it in seconds, having spent
// nothing. So the failure mode of aiming high is a retry, not another silent
// hang. Lower this if that ever happens; the plan is delta-resumable.
//
// Over-providing gas is free — unused gas is refunded — and being SHORT only
// costs the burned gas of a reverted tx (~$0.50 at Base's current base fee),
// so the estimates below deliberately carry margin rather than run lean.
// What the failures here actually were, since two of the three were self-
// inflicted and sent me hunting a size ceiling that does not exist:
//   15.9M  a REAL drop — this predates explicit gas limits, so eth_estimateGas
//          was asked, errored above its ~11M cap, left `gas` unset, and the tx
//          died at broadcast.
//   60M    NOT a size refusal. The batch carried an under-provisioned limit
//          (importApps was costed flat at 250k/app against a real ~600k), so it
//          would have run out of gas; MetaMask's smart-transaction simulation
//          cancelled it pre-broadcast as FAILED_WOULD_REVERT.
//   8M     the same thing again, smaller.
// With byte-accurate estimates and a padded send limit, there is no evidence of
// any relay ceiling. This is the size Steven picked for the human axis (~12
// hardware-wallet confirmations for a 509M-gas catalog) — set as the budget
// BEFORE sendTx's 50% padding, so the transaction that actually goes out is
// ~60M, ~15% of a Base block. If a relay ever does refuse one, the console
// halves and re-plans on its own.
// Infura -- MetaMask's default Base endpoint -- caps a single transaction at
// 25M gas and says so plainly once Smart Transactions is out of the way:
//   "eth_sendRawTransaction: exceeds maximum per-tx gas limit: 59786022 > 25000000"
// THAT is the ceiling this whole saga was about. Not the chain (400M blocks),
// not eth_estimateGas, not transaction size. sendTx pads 50%, so the budget has
// to leave room for that: 16M -> 24M sent, just inside 25M, ~39 confirmations
// for the 509M-gas catalog. A provider with a higher cap takes bigger batches
// and fewer signatures -- and the console now reads the cap out of the
// provider's own error and re-plans to fit, so it adapts without being told.
/* What a single transaction may ask for. Infura's API refuses over 25M and says
   so, but that is NOT the binding limit: sampling 3,569 transactions across 30
   recent Base blocks, the largest gas limit anything actually gets INCLUDED
   with is 15.0M, and nothing above 16M appears at all. A 24M transaction is
   therefore accepted by the RPC and then simply never mined — which reads as
   "stuck" and is what happened on 0xed641d15. Clamp to what the chain takes. */
export const MAX_TX_GAS = 15_000_000;
export const GAS_BUDGET  = 11_000_000;   // per packed tx, pre-padding (~13.8M sent, inside MAX_TX_GAS)
export const SEND_PAD_NUM = 3n, SEND_PAD_DEN = 2n;   // sendTx's 1.5x, named so callers can invert it
const DATA_BUDGET = 96 * 1024;    // per packed tx (sum of inner calls) - secondary guard
// Never subdivide below this: past it the batches are tiny, the signature count
// explodes, and a still-failing send is a different problem that halving will
// not solve. Stop and say so instead of grinding.
export const MIN_GAS_BUDGET = 2_000_000;
function packPlan(contractName, txs, budget, dataBudget) {
  if (txs.length <= 1) return txs;
  const sel = CONTRACTS[contractName].sel;
  const bytesOf = (t) => (t.dataHex.length - 2) / 2;
  const groups = [[]];
  let usedGas = 0, usedBytes = 0;
  for (const t of txs) {
    const g = t.gas || 1_000_000, b = bytesOf(t);
    if (groups[groups.length - 1].length && (usedGas + g > (budget || GAS_BUDGET) || usedBytes + b > (dataBudget || DATA_BUDGET))) { groups.push([]); usedGas = 0; usedBytes = 0; }
    groups[groups.length - 1].push(t); usedGas += g; usedBytes += b;
  }
  return groups.map((g) => g.length === 1 ? g[0] : {
    label: `multicall · ${g.length} calls (${g.map((t) => t.label.split(" ·")[0]).filter((v, i, a) => a.indexOf(v) === i).join(", ")})`,
    // carry the summed estimate: a packed tx with no declared gas is invisible
    // to every budget check downstream, which is precisely how one lands over
    // the ceiling and fails without a word
    gas: g.reduce((n, t) => n + (t.gas || 1_000_000), 0),
    dataHex: encCallX(sel.multicall, [{ t: "bytes[]", v: g.map((t) => t.dataHex) }]),
  });
}

export const MIG_KINDS = {
  deployments: {
    label: "Deployments", contractName: "EnclaveDeployments", bookKey: "deployments",
    read: readDeployments,
    counts: (d) => {
      const fees = d.filter((x) => x.fee && x.fee.rate6 !== "0").length;
      const earns = d.filter((x) => x.earn && x.earn.rate6 !== "0").length;
      return `${d.length} deployment${d.length === 1 ? "" : "s"}`
        + (fees ? ` (${fees} fee-bearing)` : "") + (earns ? ` (${earns} runner-rated)` : "");
    },
    /* delta plan: skip anything the target already holds, so an interrupted
       run resumes by re-clicking Migrate, and a second pass right before the
       book flips picks up records created on the source in the meantime. */
    plan(data, after, opts = {}) {
      const sel = CONTRACTS.EnclaveDeployments.sel;
      const have = new Set(after.map((d) => d.id.toLowerCase()));
      const todo = data.filter((d) => !have.has(d.id.toLowerCase())).map(depClean);
      // Refuse loudly rather than letting importDeployments revert "range" on
      // transaction N of a run that already spent gas on N-1.
      const rateless = todo.filter((d) => BigInt(d.rate || 0) === 0n);
      if (rateless.length)
        throw new Error(`${rateless.length} deployment(s) carry neither a rate nor a spend cap, so nothing could ever be paid to serve them: `
          + rateless.map((d) => d.id.slice(0, 10) + "…").join(", ")
          + `. Set a cap (setMaxRate) on each before migrating.`);
      const txs = chunkByGas(todo, recordImportGas, opts.gasBudget || GAS_BUDGET, CHUNK.deployments).map((c, i) => ({
        label: `importDeployments · batch ${i + 1} (${c.length})`,
        gas: 120_000 + c.reduce((s, d) => s + recordImportGas(d), 0),
        dataHex: encCallX(sel.importDeployments, [{ t: "tuple[]", schema: DEP_SCHEMA, v: c }]),
      }));
      // fee snapshots ride AFTER the record imports (importFees requires the
      // id to exist on the target; in-order packing preserves that). Delta
      // like the records: skip fees the target already holds, so a resumed
      // run re-plans only what's missing.
      const haveFee = new Set(after.filter((d) => d.fee && d.fee.rate6 !== "0").map((d) => d.id.toLowerCase()));
      const feeTodo = data.filter((d) => d.fee && d.fee.rate6 !== "0" && !haveFee.has(d.id.toLowerCase()));
      txs.push(...chunked(feeTodo, CHUNK.fees).map((c, i) => ({
        label: `importFees · batch ${i + 1} (${c.length})`,
        gas: 100_000 + 45_000 * c.length,
        dataHex: encCallX(sel.importFees, [
          { t: "bytes32[]", v: c.map((d) => d.id) },
          { t: "addr[]", v: c.map((d) => d.fee.recipient) },
          { t: "uint[]", v: c.map((d) => d.fee.rate6) },
        ]),
      })));
      // runner-rate snapshots ride the same way (importEarn requires the id to
      // exist, in-order packing preserves that), delta'd like the fees.
      //
      // A record whose SOURCE rate6 is 0 has nothing to copy - it predates the
      // runner meter. Left at 0 it can never pay a seller a cent, and (rev 10)
      // fundEscrow refuses it outright ("no runner rate"), so it can never be
      // backed or refunded either. sealImports makes all of that permanent,
      // which is why importEarn doubles as the GRANT path the ledger documents.
      // opts.grantRates computes what create() would have snapshotted for it:
      // runnerBps of the rate minus the publisher fee (_snapRunnerRate).
      const grantBps = opts.grantRates ? Number(opts.runnerBps || 0) : 0;
      const granted = new Map();
      for (const d of data) {
        const r6 = grantedRate6(d, grantBps);
        if (r6) granted.set(d.id.toLowerCase(), r6);
      }
      const rateOf = (d) => granted.get(d.id.toLowerCase()) || (d.earn && d.earn.rate6) || "0";
      const haveEarn = new Set(after.filter((d) => d.earn && d.earn.rate6 !== "0").map((d) => d.id.toLowerCase()));
      const earnTodo = data.filter((d) => rateOf(d) !== "0" && !haveEarn.has(d.id.toLowerCase()));
      txs.push(...chunked(earnTodo, CHUNK.fees).map((c, i) => ({
        label: `importEarn · batch ${i + 1} (${c.length})`
          + (c.some((d) => granted.has(d.id.toLowerCase())) ? " · includes granted rates" : ""),
        gas: 100_000 + 45_000 * c.length,
        dataHex: encCallX(sel.importEarn, [
          { t: "bytes32[]", v: c.map((d) => d.id) },
          { t: "uint[]", v: c.map(rateOf) },
        ]),
      })));
      // Spend ceilings, when the SOURCE has them (rev >= 8): importDeployments
      // already defaulted each record's cap to its rate, so only records whose
      // real cap differs need a call - which is every one an owner widened.
      const capTodo = data.filter((d) => d.cap6 !== undefined
        && d.cap6 !== String(d.rate)
        && d.cap6 !== (after.find((t) => t.id.toLowerCase() === d.id.toLowerCase()) || {}).cap6);
      txs.push(...chunked(capTodo, CHUNK.fees).map((c, i) => ({
        label: `importCaps · batch ${i + 1} (${c.length})`,
        gas: 100_000 + 45_000 * c.length,
        dataHex: encCallX(sel.importCaps, [
          { t: "bytes32[]", v: c.map((d) => d.id) },
          { t: "uint[]", v: c.map((d) => d.cap6) },
        ]),
      })));
      return packPlan("EnclaveDeployments", txs, opts.gasBudget, opts.dataBudget);
    },
    async verify(data, target, opts = {}) {
      const after = await readDeployments(target);
      const byId = Object.fromEntries(after.map((d) => [d.id.toLowerCase(), d]));
      const feeCmp = (a, b) => (a.fee?.rate6 || "0") === (b.fee?.rate6 || "0")
        && ((a.fee?.rate6 || "0") === "0" || a.fee.recipient.toLowerCase() === b.fee.recipient.toLowerCase());
      // A GRANTED rate is a deliberate difference from the source, so verify has
      // to expect it or a correct migration can never verify clean - and Seal
      // only unlocks on a clean verify. Accept exactly the granted value,
      // never merely "non-zero".
      const grantBps = opts.grantRates ? Number(opts.runnerBps || 0) : 0;
      const earnCmp = (a, b) => {
        const src = a.earn?.rate6 || "0", tgt = b.earn?.rate6 || "0";
        return src === tgt || (src === "0" && tgt === grantedRate6(a, grantBps));
      };
      // a cap the source didn't have is whatever the target defaulted it to
      const capCmp = (a, b) => a.cap6 === undefined || a.cap6 === b.cap6;
      const bad = data.filter((d) => {
        const t = byId[d.id.toLowerCase()];
        return !t || !depCmp(d, t) || !feeCmp(d, t) || !earnCmp(d, t) || !capCmp(d, t);
      }).map((d) => {
        const t = byId[d.id.toLowerCase()];
        const why = t && depCmp(d, t) ? (!feeCmp(d, t) ? "fee · " : !earnCmp(d, t) ? "runner rate · " : "rate cap · ") : "";
        return d.id.slice(0, 10) + "… (" + why + d.appRef + ")";
      });
      return { total: data.length, ok: data.length - bad.length, bad };
    },
  },
  catalog: {
    label: "App catalog", contractName: "EnclaveAppCatalog", bookKey: "appCatalog",
    read: readCatalog,
    counts: (d) => {
      const fees = d.reduce((n, a) => n + a.versions.filter((v) => (v.fee6 || "0") !== "0").length, 0);
      return `${d.length} app${d.length === 1 ? "" : "s"}, ${d.reduce((n, a) => n + a.versions.length, 0)} versions`
        + (fees ? ` (${fees} fee-bearing)` : "");
    },
    plan(data, after, opts = {}) {
      const gasBudget = opts.gasBudget || GAS_BUDGET, dataBudget = opts.dataBudget || DATA_BUDGET;
      const sel = CONTRACTS.EnclaveAppCatalog.sel;
      const have = Object.fromEntries(after.map((a) => [a.appId.toLowerCase(), a]));
      const newApps = data.filter((a) => !have[a.appId.toLowerCase()]);
      const txs = chunkByGas(newApps, appImportGas, gasBudget, CHUNK.apps).map((c, i) => ({
        label: `importApps · batch ${i + 1} (${c.length})`,
        gas: 100_000 + c.reduce((t, a) => t + appImportGas(a), 0),
        dataHex: encCallX(sel.importApps, [{ t: "tuple[]", schema: APP_SCHEMA, v: c }]),
      }));
      for (const a of data) {
        // versions are append-only in publish order: the target holds a prefix
        const tgt = have[a.appId.toLowerCase()];
        const done = tgt ? tgt.versions.length : 0;
        for (const [i, c] of chunkBySizeAndGas(a.versions.slice(done), Math.min(VER_TX_BYTES, dataBudget), verSize,
                                                Math.min(VER_TX_GAS, gasBudget), versionImportGas).entries())
          txs.push({ label: `importVersions · ${a.slug} (${c.length}${done || i ? ", cont." : ""})`,
            // the REAL cost, per version, from its own string bytes — packPlan
            // packs on this number, so a flat guess here is a dropped tx there
            gas: 100_000 + c.reduce((t, v) => t + versionImportGas(v), 0),
            dataHex: encCallX(sel.importVersions, [{ t: "bytes32", v: a.appId }, { t: "tuple[]", schema: VER_SCHEMA, v: c }]) });
        // per-version fee snapshots ride AFTER the app's version imports
        // (importVersionFees bounds-checks the index against the target's
        // version count; in-order packing preserves that). Delta like the
        // ledger's fees: a fee is immutable at the source, so "target holds a
        // nonzero fee at this index" means it's already carried.
        const feeTodo = a.versions.map((v, i) => ({ i, fee6: v.fee6 || "0" }))
          .filter((x) => x.fee6 !== "0" && (tgt && tgt.versions[x.i] ? (tgt.versions[x.i].fee6 || "0") === "0" : true));
        txs.push(...chunked(feeTodo, CHUNK.fees).map((c, i) => ({
          label: `importVersionFees · ${a.slug} (${c.length}${i ? ", cont." : ""})`,
          gas: 100_000 + 45_000 * c.length,
          dataHex: encCallX(sel.importVersionFees, [
            { t: "bytes32", v: a.appId },
            { t: "uint[]", v: c.map((x) => x.i) },
            { t: "uint[]", v: c.map((x) => x.fee6) },
          ]),
        })));
        // ...and the config CIDs, same delta rule (a CID is immutable at the
        // source, so a non-empty one at the target means it is already carried)
        const cidTodo = a.versions.map((v, i) => ({ i, cid: v.cfgCid || "" }))
          .filter((x) => x.cid && (tgt && tgt.versions[x.i] ? !(tgt.versions[x.i].cfgCid || "") : true));
        txs.push(...chunked(cidTodo, CHUNK.fees).map((c, i) => ({
          label: `importVersionConfigCids · ${a.slug} (${c.length}${i ? ", cont." : ""})`,
          gas: 100_000 + c.reduce((t, x) => t + Math.ceil(60_000 + G_PER_BYTE * strBytes(x.cid)), 0),
          dataHex: encCallX(sel.importVersionConfigCids, [
            { t: "bytes32", v: a.appId },
            { t: "uint[]", v: c.map((x) => x.i) },
            { t: "str[]", v: c.map((x) => x.cid) },
          ]),
        })));
      }
      return packPlan("EnclaveAppCatalog", txs, gasBudget, dataBudget);
    },
    async verify(data, target) {
      const after = await readCatalog(target);
      const byId = Object.fromEntries(after.map((a) => [a.appId.toLowerCase(), a]));
      const bad = [];
      for (const a of data) {
        const t = byId[a.appId.toLowerCase()];
        if (!t || !appCmp(a, t)) { bad.push(a.slug); continue; }
        if (a.versions.length !== t.versions.length || !a.versions.every((v, i) => verCmp(v, t.versions[i])))
          { bad.push(a.slug + " (versions)"); continue; }
        if (!a.versions.every((v, i) => (v.fee6 || "0") === (t.versions[i].fee6 || "0")))
          { bad.push(a.slug + " (fees)"); continue; }
        // A missed config CID leaves a version that still deploys and still
        // looks healthy while serving its routing manifest as its config — so
        // verify it explicitly rather than trusting the plan ran.
        if (!a.versions.every((v, i) => (v.cfgCid || "") === (t.versions[i].cfgCid || "")))
          bad.push(a.slug + " (config CIDs)");
      }
      return { total: data.length, ok: data.length - bad.length, bad };
    },
  },
};

export function sealTx(contractName) {
  return "0x" + CONTRACTS[contractName].sel.sealImports;
}
