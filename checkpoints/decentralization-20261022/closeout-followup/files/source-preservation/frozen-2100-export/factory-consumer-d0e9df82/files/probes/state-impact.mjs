// READ-ONLY, at ONE block both state endpoints agree on, at most 20 requests: for EVERY deployment id in the CURRENT
// ledger the book names, the owner before (the ledger owner: the factory entry is zero, which this probe re-reads) and
// after activation (isVault(owner) at the original factory ? that SessionVault's owner() : the ledger owner), and the
// v1 and v2 policy of that id, classified by lib/review.mjs effectOf. No bundle or rules bytes are emitted.
//   node probes/state-impact.mjs   -> evidence/state-impact.json
import fs from "node:fs";
import { budgetedRpc, pinBlock, readAgreed, ABI, effectOf, ZERO } from "../lib/review.mjs";
import { stringToHex } from "viem";

const BOOK = "0xab214342d5a490150a4a977063a2f88e21f80907";
const FACTORY = "0x1f5c887c0cdf491b16ab6c449abafdf9b2ec9c9c";                 // root session-factory-state / activation plan
const LEDGER_EXPECTED = "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b";          // root known-state: book "deployments"
const V1 = "0x08074300f75e78212ae10ebd14984f78e17811a6", V2 = "0xe48699b8401564aace7a814ae4569b67a3f7eef5";
const ADMIN_SV = "0xb794c4dd0e1c5e6b72281799f282bfde7654345d";
const MAX = 20;
const lc = (a) => String(a).toLowerCase();
const key = (s) => stringToHex(s, { size: 32 });
const out = { at: new Date().toISOString(), readOnly: true, budget: MAX, complete: false };
const b = budgetedRpc({ max: MAX });
const save = () => fs.writeFileSync(new URL("../evidence/state-impact.json", import.meta.url),
  JSON.stringify({ ...out, requests: b.log }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1) + "\n");
const plan = (n, size) => Math.ceil(n / size) * 2;
try {
  const block = await pinBlock(b.rpc); out.block = block;
  const head = await readAgreed(b.rpc, block, [
    { address: BOOK, abi: ABI.book, functionName: "addr", args: [key("sessionVaultFactory")] },
    { address: BOOK, abi: ABI.book, functionName: "addr", args: [key("deployments")] },
    { address: BOOK, abi: ABI.book, functionName: "owner" },
    { address: LEDGER_EXPECTED, abi: ABI.ledger, functionName: "count" },
    { address: FACTORY, abi: ABI.factory, functionName: "isVault", args: [ADMIN_SV] },
    { address: ADMIN_SV, abi: ABI.sv, functionName: "owner" },
    { address: ADMIN_SV, abi: ABI.sv, functionName: "factory" },
    { address: ADMIN_SV, abi: ABI.sv, functionName: "book" },
  ]);
  const v = head.map((r) => (r.ok ? (Array.isArray(r.value) ? r.value[0] : r.value) : null));
  out.book = { address: BOOK, sessionVaultFactory: lc(v[0]), deployments: lc(v[1]), owner: lc(v[2]) };
  out.adminSessionVault = { address: ADMIN_SV, isVaultAtFactory: v[4], owner: v[5] && lc(v[5]), factory: v[6] && lc(v[6]), book: v[7] && lc(v[7]) };
  if (out.book.sessionVaultFactory !== ZERO) throw new Error(`the factory entry is no longer zero (${out.book.sessionVaultFactory}): this review's "before" no longer holds`);
  if (out.book.deployments !== LEDGER_EXPECTED) throw new Error(`the book's ledger is ${out.book.deployments}, not the expected ${LEDGER_EXPECTED}`);
  if (v[3] === null) throw new Error("the ledger has no count(): ids cannot be enumerated by state");
  const n = Number(v[3]); out.ledger = { address: LEDGER_EXPECTED, count: n };
  const ID_BATCH = 1500, OWN_BATCH = 300, POL_BATCH = 300;
  const need = plan(n, ID_BATCH) + plan(n, OWN_BATCH) + plan(n * 2, POL_BATCH) + 2;
  out.requestPlan = { used: b.used(), need, max: MAX };
  if (b.used() + need > MAX) throw new Error(`${n} ids need ${need} more requests: over this attempt's budget (no partial claim)`);
  // ids
  const ids = [];
  for (let i = 0; i < n; i += ID_BATCH) {
    const r = await readAgreed(b.rpc, block, Array.from({ length: Math.min(ID_BATCH, n - i) }, (_, j) => ({ address: LEDGER_EXPECTED, abi: ABI.ledger, functionName: "idAt", args: [BigInt(i + j)] })));
    for (const x of r) { if (!x.ok) throw new Error("idAt failed"); ids.push(lc(x.value)); }
  }
  if (new Set(ids).size !== ids.length) throw new Error("duplicate ids in the ledger enumeration");
  // ledger owners (v2.beneficialOwnerOf == the ledger owner while the factory entry is zero)
  const owners = [];
  for (let i = 0; i < n; i += OWN_BATCH) {
    const r = await readAgreed(b.rpc, block, ids.slice(i, i + OWN_BATCH).map((id) => ({ address: V2, abi: ABI.vault, functionName: "beneficialOwnerOf", args: [id] })));
    for (const x of r) { if (!x.ok) throw new Error("beneficialOwnerOf failed"); owners.push(lc(x.value)); }
  }
  // per distinct owner: isVault at the original factory and, if a contract answers, its owner()
  const distinct = [...new Set(owners)];
  const ownerInfo = new Map();
  const r1 = await readAgreed(b.rpc, block, distinct.flatMap((o) => [{ address: FACTORY, abi: ABI.factory, functionName: "isVault", args: [o] }, { address: o, abi: ABI.sv, functionName: "owner" }]));
  distinct.forEach((o, i) => { const iv = r1[2 * i], ow = r1[2 * i + 1]; if (!iv.ok) throw new Error("isVault failed"); ownerInfo.set(o, { isVault: iv.value, svOwner: ow.ok ? lc(ow.value) : null }); });
  // policies in both vaults for every id
  const pol = new Map();
  const polCalls = ids.flatMap((id) => [{ address: V1, abi: ABI.vault, functionName: "policyOf", args: [id] }, { address: V2, abi: ABI.vault, functionName: "policyOf", args: [id] }]);
  for (let i = 0; i < polCalls.length; i += POL_BATCH) {
    const r = await readAgreed(b.rpc, block, polCalls.slice(i, i + POL_BATCH));
    r.forEach((x, j) => { if (!x.ok) throw new Error("policyOf failed"); const [owner, policyRev, secretRev, committeeId, paused] = x.value;
      pol.set(`${polCalls[i + j].address}:${polCalls[i + j].args[0]}`, { owner: lc(owner), policyRev: policyRev.toString(), secretRev: secretRev.toString(), committeeId, paused }); });
  }
  out.rows = ids.map((id, i) => {
    const before = owners[i], info = ownerInfo.get(before), after = info.isVault ? info.svOwner : before;
    if (info.isVault && (!after || after === ZERO)) throw new Error(`a recognized SessionVault ${before} has no owner()`);
    const v1 = pol.get(`${V1}:${id}`), v2 = pol.get(`${V2}:${id}`);
    return { id, ledgerOwner: before, ownerIsFactoryVault: info.isVault, ownerAfter: after,
             v1: { ...v1, effect: effectOf({ before, after, policy: v1 }) }, v2: { ...v2, effect: effectOf({ before, after, policy: v2 }) } };
  });
  const count = (f) => out.rows.filter(f).length;
  out.summary = {
    ids: n, distinctOwners: distinct.length,
    idsOwnedByFactoryVaults: count((r) => r.ownerIsFactoryVault),
    factoryVaultOwners: distinct.filter((o) => ownerInfo.get(o).isVault),
    policies: { v1: count((r) => r.v1.policyRev !== "0"), v2: count((r) => r.v2.policyRev !== "0") },
    effects: Object.fromEntries(["STRANDED", "restored", "claimant_changes", "no_policy_first_writer_changes", "unchanged"].map((k) =>
      [k, { v1: count((r) => r.v1.effect === k), v2: count((r) => r.v2.effect === k) }])),
    policiesPinnedToAContractOwner: out.rows.flatMap((r) => [["v1", r.v1], ["v2", r.v2]].filter(([, p]) => p.policyRev !== "0" && p.owner === r.ledgerOwner && r.ownerIsFactoryVault).map(([vv]) => `${vv}:${r.id}`)),
  };
  out.complete = true;
  out.scope = "every id in the CURRENT ledger at this block; ids absent from it have beneficialOwnerOf 0 before and after (unaffected)";
} catch (e) {
  out.error = String(e.message).slice(0, 300);
} finally {
  out.requestsUsed = b.used();
  save();
  console.log(JSON.stringify({ complete: out.complete, error: out.error || null, block: out.block?.number?.toString(), ids: out.ledger?.count, summary: out.summary || null, requests: b.used() }, null, 1));
  if (!out.complete) process.exitCode = 2;
}
