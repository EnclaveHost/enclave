// SMALL-BUDGET VARIANT (queued-funding-small, 2026-10-22) of ens-outage-20261022/batch-topup-review/batch-topup.mjs aee7bd99:
// identical code, ONLY the per-row amount is 0.0001 ETH (1e14 wei; 10 rows = 0.001 ETH) and its messages say so.
// OPTIONAL batch lease-gas top-up PROPOSAL generator (offline; prepared for root, never a wallet request).
//
// It turns an explicitly supplied manifest {id, currentOwner, amountWei} plus root's fresh multi-RPC evidence into ONE
// unsigned call description: canonical Multicall3.aggregate3Value([...{target: reserve, allowFailure: false,
// value: amountWei, callData: deposit(id)}]) with msg.value exactly the sum. It makes no network call, holds no key, and
// emits no from/nonce/gas/chain-intent fields. Root (after the user's approval) owns any wallet preparation.
//
// Why this is safe ONLY under the checks below (see REVIEW.md):
//   - reserve.deposit(id) credits _reserves[keccak(id, ledger.get(id).owner)] - the CURRENT owner of record at
//     execution, whoever pays (msg.sender = Multicall3 is recorded only as the event's payer);
//   - Multicall3.aggregate3Value reverts the whole transaction if any allowFailure=false call fails and requires
//     msg.value == sum(values): all-or-nothing, nothing left in Multicall3, nothing refunded or approved;
//   - deposit has no allowance/approval/withdraw path; this generator only ever encodes deposit(bytes32).
// Residual risk it cannot remove: an owner transfer between root's fresh read and inclusion would credit the new owner's
// reserve (there is no on-chain owner assertion primitive in Multicall3, the reserve or the ledger).
import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";

const req = createRequire(new URL("../../enclave/package.json", import.meta.url));
const { encodeFunctionData, decodeFunctionData, getAddress, isAddress } = await import(req.resolve("viem"));

export const CHAIN_ID = 8453;
// production reserve + ledger, from outputs/app-lease-gas-review/lease-gas-deployment.json and root's deposit-plan.mjs
export const RESERVE = "0x12A3f873041Dec436DaA0085B766a399A6fA3639";
export const RESERVE_CODEHASH = "0xcc00efe9c79c17b34ef9edc2720939030834bf168abc52cea14dcb224304a979";
export const LEDGER = "0xB1783B61E1FDee6a6163DC3CdaC27bF32E7d117B";
export const LEDGER_CODEHASH = "0x71d50076336283e774ba2ef8d5cbf7602e9cdc5dd918a7e7390c743367766682";
// canonical Multicall3 ADDRESS (viem chains/definitions/base.js). Its code hash is NOT pinned here: root supplies it.
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const EMPTY_CODEHASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
export const SEL_AGGREGATE3VALUE = "0x174dea71";   // aggregate3Value((address,bool,uint256,bytes)[])
export const SEL_DEPOSIT = "0xb214faa5";           // deposit(bytes32)
// the proposal: exactly 0.0001 ETH per app, at most the 10 non-adapter reserves (no spending authority implied)
export const AMOUNT_WEI = 100_000_000_000_000n;
export const MAX_ROWS = 10;
export const MAX_TOTAL_WEI = AMOUNT_WEI * BigInt(MAX_ROWS);
// root's separate single-adapter deposit page covers this one; a batch row would double-pay it
export const EXCLUDED = Object.freeze({
  "0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33": "the adapter has root's separate pending single deposit",
});
export const DEFAULT_MAX_AGE_SEC = 600;

export const MANIFEST_FORMAT = "enclave-reserve-batch-topup-manifest/v1";
export const EVIDENCE_FORMAT = "enclave-reserve-batch-evidence/v1";
export const PROPOSAL_FORMAT = "enclave-reserve-batch-topup-proposal/v1";

const DEPOSIT_ABI = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] }];
const MC3_ABI = [{ type: "function", name: "aggregate3Value", stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" },
    { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
  outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] }];

export class Refusal extends Error { constructor(m) { super(m); this.name = "Refusal"; } }
const refuse = (m) => { throw new Refusal(m); };
const lc = (s) => String(s).toLowerCase();
const ID_RE = /^0x[0-9a-f]{64}$/;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const DEC_RE = /^[0-9]{1,78}$/;

/** The manifest: explicit rows, each 0.0001 ETH, unique, current owner named. -> [{id, currentOwner, amountWei, label}] */
export function parseManifest(m) {
  if (!m || m.format !== MANIFEST_FORMAT) refuse(`manifest format must be ${MANIFEST_FORMAT}`);
  if (m.chainId !== CHAIN_ID) refuse(`manifest chainId must be ${CHAIN_ID}`);
  if (!Array.isArray(m.rows) || m.rows.length < 1 || m.rows.length > MAX_ROWS) refuse(`manifest needs 1..${MAX_ROWS} rows`);
  const seen = new Set();
  return m.rows.map((r, i) => {
    const allowed = ["id", "currentOwner", "amountWei", "label"];
    const extra = Object.keys(r || {}).filter((k) => !allowed.includes(k));
    if (extra.length) refuse(`row ${i}: unknown field ${extra[0]}`);
    if (typeof r.id !== "string" || !ID_RE.test(r.id)) refuse(`row ${i}: id must be a lowercase 0x bytes32`);
    if (/^0x0{64}$/.test(r.id)) refuse(`row ${i}: zero id`);
    if (EXCLUDED[r.id]) refuse(`row ${i}: ${r.id.slice(0, 10)} is excluded (${EXCLUDED[r.id]})`);
    if (seen.has(r.id)) refuse(`row ${i}: duplicate id ${r.id.slice(0, 10)}`);
    seen.add(r.id);
    if (typeof r.currentOwner !== "string" || !isAddress(r.currentOwner, { strict: false })) refuse(`row ${i}: currentOwner must be an address`);
    if (/^0x0{40}$/i.test(r.currentOwner)) refuse(`row ${i}: zero owner`);
    if (typeof r.amountWei !== "string" || !DEC_RE.test(r.amountWei) || BigInt(r.amountWei) !== AMOUNT_WEI)
      refuse(`row ${i}: amountWei must be exactly "${AMOUNT_WEI}" (0.0001 ETH, the small-budget proposal)`);
    return { id: r.id, currentOwner: getAddress(r.currentOwner), amountWei: AMOUNT_WEI, label: typeof r.label === "string" ? r.label.slice(0, 80) : "" };
  });
}

/** Root's fresh evidence: >= 2 distinct RPC hosts, identical answers at one block, recent, pinned code, owners as named,
 *  every reserve ENABLED under its current owner's key (proof that owner itself called configure, so it can act and
 *  withdraw). -> the agreed read. */
export function checkEvidence(ev, rows, { expectedMulticall3CodeHash, now = Date.now(), maxAgeSec = DEFAULT_MAX_AGE_SEC } = {}) {
  if (typeof expectedMulticall3CodeHash !== "string" || !HASH_RE.test(lc(expectedMulticall3CodeHash)))
    refuse("the expected Multicall3 code hash must be supplied by root (0x + 64 hex, from independent reads); it is never assumed");
  const mcHash = lc(expectedMulticall3CodeHash);
  if (mcHash === EMPTY_CODEHASH) refuse("the expected Multicall3 code hash is the empty-code hash");
  if (!ev || ev.format !== EVIDENCE_FORMAT || ev.chainId !== CHAIN_ID) refuse(`evidence must be ${EVIDENCE_FORMAT} for chain ${CHAIN_ID}`);
  if (!Array.isArray(ev.reads) || ev.reads.length < 2) refuse("evidence needs at least two RPC reads");
  const hosts = new Set();
  for (const r of ev.reads) {
    let host; try { host = new URL(r.rpc).hostname.toLowerCase(); } catch { refuse("evidence read without a valid rpc URL"); }
    if (r.error) continue;
    hosts.add(host);
  }
  const ok = ev.reads.filter((r) => !r.error);
  if (ok.length < 2 || hosts.size < 2) refuse("evidence needs at least two successful reads from distinct RPC hosts");
  const canon = (r) => JSON.stringify({ chainId: r.chainId, blockNumber: String(r.blockNumber), blockHash: lc(r.blockHash),
    timestamp: String(r.timestamp), multicall3CodeHash: lc(r.multicall3CodeHash), reserveCodeHash: lc(r.reserveCodeHash),
    ledgerCodeHash: lc(r.ledgerCodeHash), reservePaused: r.reservePaused,
    rows: (r.rows || []).map((x) => ({ id: lc(x.id), ledgerId: lc(x.ledgerId), owner: lc(x.owner), active: x.active, enabled: x.enabled,
      blocked: x.blocked, balanceWei: String(x.balanceWei) })) });
  const first = canon(ok[0]);
  if (!ok.every((r) => canon(r) === first)) refuse("the RPC reads disagree (block, code or reserve state): re-read at one agreed block");
  const a = ok[0];
  if (a.chainId !== CHAIN_ID) refuse("evidence read on another chain");
  if (!DEC_RE.test(String(a.blockNumber)) || !HASH_RE.test(lc(a.blockHash)) || !DEC_RE.test(String(a.timestamp))) refuse("evidence block fields malformed");
  const age = Math.floor(now / 1000) - Number(a.timestamp);
  if (age > maxAgeSec) refuse(`evidence block is ${age} s old (> ${maxAgeSec} s): re-read owners and code immediately before preparing`);
  if (age < -60) refuse("evidence block timestamp is in the future");
  if (lc(a.multicall3CodeHash) !== mcHash) refuse("Multicall3 code at the canonical address differs from the root-supplied hash");
  if (lc(a.reserveCodeHash) !== RESERVE_CODEHASH) refuse("reserve code differs from the reviewed production reserve");
  if (lc(a.ledgerCodeHash) !== LEDGER_CODEHASH) refuse("ledger code differs from the reviewed production ledger");
  if (a.reservePaused !== false) refuse("the reserve is paused (or its paused flag was not read): sponsored leases cannot use a deposit now");
  if (!Array.isArray(a.rows) || a.rows.length !== rows.length) refuse("evidence rows must cover exactly the manifest rows");
  const byId = new Map(a.rows.map((x) => [lc(x.id), x]));
  if (byId.size !== a.rows.length) refuse("evidence repeats an id");
  for (const row of rows) {
    const x = byId.get(row.id);
    if (!x) refuse(`evidence lacks ${row.id.slice(0, 10)}`);
    if (lc(x.ledgerId) !== row.id) refuse(`${row.id.slice(0, 10)}: the ledger does not know this deployment`);
    if (lc(x.owner) !== lc(row.currentOwner)) refuse(`${row.id.slice(0, 10)}: current owner ${x.owner} differs from the manifest's ${row.currentOwner}`);
    if (x.active !== true) refuse(`${row.id.slice(0, 10)}: deployment is not active`);
    if (x.blocked !== false) refuse(`${row.id.slice(0, 10)}: the deployment is blocked at the reserve (or the flag was not read)`);
    if (x.enabled !== true) refuse(`${row.id.slice(0, 10)}: the current owner's reserve is not enabled (a deposit would sit unused until that owner configures it)`);
    if (!DEC_RE.test(String(x.balanceWei))) refuse(`${row.id.slice(0, 10)}: balance malformed`);
  }
  return { blockNumber: String(a.blockNumber), blockHash: lc(a.blockHash), timestamp: String(a.timestamp), hosts: [...hosts].sort(), byId };
}

/** The unsigned call description. expectTotalWei must equal the exact sum (the caller states the bound it approves). */
export function buildProposal({ manifest, evidence, expectedMulticall3CodeHash, expectTotalWei, now, maxAgeSec }) {
  const rows = parseManifest(manifest);
  const agreed = checkEvidence(evidence, rows, { expectedMulticall3CodeHash, now, maxAgeSec });
  const total = rows.reduce((s, r) => s + r.amountWei, 0n);
  if (total > MAX_TOTAL_WEI) refuse("total exceeds the reviewed bound");
  if (typeof expectTotalWei !== "string" || !DEC_RE.test(expectTotalWei) || BigInt(expectTotalWei) !== total)
    refuse(`expectTotalWei must state the exact total ${total} wei`);
  const calls = rows.map((r) => ({ target: getAddress(RESERVE), allowFailure: false, value: r.amountWei,
    callData: encodeFunctionData({ abi: DEPOSIT_ABI, functionName: "deposit", args: [r.id] }) }));
  const data = encodeFunctionData({ abi: MC3_ABI, functionName: "aggregate3Value", args: [calls] });
  const proposal = {
    format: PROPOSAL_FORMAT,
    status: "PROPOSAL ONLY - not a wallet request; no sender, nonce, gas or fee fields; root prepares nothing until the user approves",
    chainId: CHAIN_ID, to: getAddress(MULTICALL3), value: String(total), data,
    dataSha256: crypto.createHash("sha256").update(data).digest("hex"),
    evidence: { blockNumber: agreed.blockNumber, blockHash: agreed.blockHash, timestamp: agreed.timestamp, hosts: agreed.hosts,
      multicall3CodeHash: lc(expectedMulticall3CodeHash) },
    rows: rows.map((r) => ({ id: r.id, label: r.label, creditedOwner: r.currentOwner, amountWei: String(r.amountWei),
      reserveBalanceAtEvidenceWei: String(agreed.byId.get(r.id).balanceWei) })),
  };
  verifyProposal(proposal);
  return proposal;
}

/** Independent decode of a proposal's bytes: only aggregate3Value -> deposit(bytes32) on the reserve, allowFailure false,
 *  values summing exactly to the transaction value, ids and amounts exactly the listed rows. */
export function verifyProposal(p) {
  if (p.format !== PROPOSAL_FORMAT || p.chainId !== CHAIN_ID) refuse("not a batch top-up proposal");
  for (const k of ["from", "nonce", "gas", "gasLimit", "maxFeePerGas", "maxPriorityFeePerGas", "authorizationList"])
    if (k in p) refuse(`a proposal never carries ${k}`);
  if (lc(p.to) !== lc(MULTICALL3)) refuse("not addressed to canonical Multicall3");
  if (!lc(p.data).startsWith(SEL_AGGREGATE3VALUE)) refuse("not aggregate3Value");
  if (crypto.createHash("sha256").update(p.data).digest("hex") !== p.dataSha256) refuse("data digest mismatch");
  const { functionName, args } = decodeFunctionData({ abi: MC3_ABI, data: p.data });
  if (functionName !== "aggregate3Value") refuse("not aggregate3Value");
  const calls = args[0];
  if (calls.length !== p.rows.length || calls.length < 1 || calls.length > MAX_ROWS) refuse("call count differs from the rows");
  let sum = 0n;
  calls.forEach((c, i) => {
    if (lc(c.target) !== lc(RESERVE)) refuse(`call ${i} targets ${c.target}, not the production reserve`);
    if (c.allowFailure !== false) refuse(`call ${i} allows failure (the batch must be all-or-nothing)`);
    if (c.value !== AMOUNT_WEI) refuse(`call ${i} value ${c.value} is not the reviewed amount`);
    if (!lc(c.callData).startsWith(SEL_DEPOSIT) || c.callData.length !== 2 + 8 + 64) refuse(`call ${i} is not deposit(bytes32)`);
    const d = decodeFunctionData({ abi: DEPOSIT_ABI, data: c.callData });
    if (lc(d.args[0]) !== p.rows[i].id || BigInt(p.rows[i].amountWei) !== c.value) refuse(`call ${i} differs from row ${i}`);
    if (EXCLUDED[lc(d.args[0])]) refuse(`call ${i} deposits to an excluded deployment`);
    sum += c.value;
  });
  if (new Set(calls.map((c) => lc(c.callData))).size !== calls.length) refuse("a deployment is paid twice");
  if (String(sum) !== p.value || sum > MAX_TOTAL_WEI) refuse("transaction value differs from the sum of the calls");
  return { calls: calls.length, totalWei: String(sum) };
}

// CLI: node batch-topup.mjs --manifest m.json --evidence e.json --multicall3-codehash 0x… --expect-total-wei N
if (process.argv[1] && new URL(import.meta.url).pathname === fs.realpathSync(process.argv[1])) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  try {
    const p = buildProposal({ manifest: JSON.parse(fs.readFileSync(arg("--manifest"), "utf8")),
      evidence: JSON.parse(fs.readFileSync(arg("--evidence"), "utf8")),
      expectedMulticall3CodeHash: arg("--multicall3-codehash"), expectTotalWei: arg("--expect-total-wei") });
    console.log(JSON.stringify(p, null, 2));
  } catch (e) { console.error(`REFUSED: ${e.message}`); process.exitCode = 2; }
}
