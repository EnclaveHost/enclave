// batch-plan.mjs: the OPTIONAL 10-app lease-gas batch top-up (0.001 ETH each, 0.01 ETH total plus gas; the adapter
// 0x7ae476a3 EXCLUDED) as ONE step for the reviewed wallet-handoff bridge (work/ens-outage-20261022/deposit-ui/bridge.mjs).
// It is a step plan, exactly like work/ens-outage-20261022/deposit-plan.mjs. It never signs, sends or asks a wallet
// anything itself: the bridge prepares one journaled intent through the durable external signer (quorum simulation,
// gas estimate, pending nonce, fee caps), re-runs check() at a fresh agreed block both at prepare and immediately before
// the single wallet request, and confirms a returned hash by the quorum's receipt.
//
// check(chain), at ONE block agreed by the RPC quorum:
//   - reads per RPC host, recorded per host (a side table, so the agreement key is not changed): chain id, block, code hashes
//     of canonical Multicall3, the reserve and the ledger; reserve.paused(); for each row ledger.get(id) (id, CURRENT
//     owner, active, appRef), reserveOf(id, current owner) (enabled, balance) and blockedDeployment(id); the current
//     catalog name/version of each row's appRef (display only); the sender's balance;
//   - turns the agreeing hosts' reads into an enclave-reserve-batch-evidence/v1 document and calls the REVIEWED
//     buildProposal() (work/ens-outage-20261022/batch-topup-review/batch-topup.mjs, unchanged). That re-checks at least two
//     distinct hosts, identical answers, freshness (600 s), pinned reserve/ledger code, the root-supplied Multicall3 code
//     hash, owner == manifest, active, enabled, not blocked, not paused, exactly 0.001 ETH per row and the stated total,
//     and verifyProposal() decodes every call (deposit(bytes32) on the reserve, allowFailure false, value sum == msg.value);
//   - DONE only when a confirmed intent of THIS plan exists AND its receipt, read by the quorum, is successful, from the
//     sender, to Multicall3, and carries exactly one reserve Deposited(id, currentOwner, Multicall3, 0.001 ETH) per row
//     and nothing else from the reserve. A confirmed intent whose receipt does not prove that is BLOCKED (never ready
//     again); so is any confirmed or open intent of another batch-top-up plan: a batch is never paid twice.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = process.env.ENCLAVE_WORK || path.resolve(HERE, "..");   // the work root (mutation controls run a copy elsewhere)
const req = createRequire(path.join(W, "enclave/package.json"));
const { keccak256, decodeEventLog, formatEther, getAddress } = await import(req.resolve("viem"));
const { OWNER_ABI, LEDGER_ABI } = await import(path.join(W, "enclave/network/lease-gas-owner.mjs"));
const BT = await import(path.join(W, "ens-outage-20261022/batch-topup-review/batch-topup.mjs"));
const { isOpen } = await import(path.join(W, "wallet-handoff-bridge/tree/cli/independent-signer.mjs"));
export const { RESERVE, LEDGER, MULTICALL3, CHAIN_ID, AMOUNT_WEI, EXCLUDED, EVIDENCE_FORMAT, Refusal, parseManifest, buildProposal, verifyProposal } = BT;
const CATALOG_ABI = JSON.parse(fs.readFileSync(path.join(W, "enclave/contracts/EnclaveAppCatalog.abi.json"), "utf8"));
export const CATALOG = "0x18419CA2b502D423A8de6269AEeE171a378626e3";   // operations-plan.json contracts.catalog
export const PLAN_PREFIX = "queued-recovery-batch-topup-20261022";
const DEPOSITED_ABI = [{ type: "event", name: "Deposited", inputs: [{ name: "id", type: "bytes32", indexed: true }, { name: "owner", type: "address", indexed: true },
  { name: "from", type: "address", indexed: true }, { name: "amountWei", type: "uint256", indexed: false }] }];
const lc = (s) => String(s ?? "").toLowerCase();
const canonical = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Display label from the CURRENT catalog record (name + version label), or the appRef when the catalog cannot say. */
async function catalogLabel(c, blockNumber, appRef) {
  const m = /^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/i.exec(appRef || "");
  if (!m) return { appRef, label: appRef || "(no appRef)" };
  try {
    const [app, ver] = await Promise.all([c.readContract({ address: CATALOG, abi: CATALOG_ABI, functionName: "getApp", args: [m[1]], blockNumber }),
      c.readContract({ address: CATALOG, abi: CATALOG_ABI, functionName: "getVersion", args: [m[1], BigInt(m[2])], blockNumber })]);
    return { appRef, label: `${String(app.name).slice(0, 48)} ${String(ver.version).slice(0, 16)} (catalog ${m[1].slice(0, 8)} v${m[2]})` };
  } catch { return { appRef, label: `catalog ${m[1].slice(0, 8)} v${m[2]}` }; }
}

/**
 * batchPlan({ manifest, from, multicall3CodeHash, expectTotalWei, maxFeeWeiAllowance, intents })
 *   intents(): the journal's records (bridge-tagged), used for done / duplicate decisions; injected so tests and the
 *   server use the same rule.
 */
export function batchPlan({ manifest, from, multicall3CodeHash, expectTotalWei, maxFeeWeiAllowance = 120_000_000_000_000n, intents = () => [], now = Date.now,
  codeHashOf = (code) => keccak256(code || "0x") /* test seam only: production always hashes the code it read */ }) {
  const rows = parseManifest(manifest);                       // reviewed: 1..10 unique rows, exactly 0.001 ETH, adapter refused
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(from))) throw new Refusal("from must be the sender address");
  const total = rows.reduce((s, r) => s + r.amountWei, 0n);
  if (String(expectTotalWei) !== String(total)) throw new Refusal(`expectTotalWei must state the exact total ${total} wei`);
  const manifestSha = crypto.createHash("sha256").update(canonical(manifest)).digest("hex");
  const id = `${PLAN_PREFIX}-${manifestSha.slice(0, 16)}`;
  const sender = getAddress(from);

  /** -> { state: "none" } | { state: "confirmed", rec } | { state: "foreign", rec } (another batch plan's live or confirmed intent) */
  function priorIntents() {
    const all = intents().filter((r) => typeof r.bridge?.plan === "string" && r.bridge.plan.startsWith(PLAN_PREFIX) && lc(r.from) === lc(sender));
    // another batch plan's intent that is not provably unsent (open, confirmed, or mined as something else) blocks this one
    const foreign = all.find((r) => r.bridge.plan !== id && (isOpen(r) || r.state === "confirmed" || r.state === "mismatch"));
    if (foreign) return { state: "foreign", rec: foreign };
    const confirmed = all.filter((r) => r.bridge.plan === id && r.state === "confirmed");
    if (confirmed.length > 1) return { state: "foreign", rec: confirmed[1] };
    return confirmed.length ? { state: "confirmed", rec: confirmed[0] } : { state: "none" };
  }

  /** The receipt of a confirmed intent proves exactly the planned deposits. -> null when proven, else the reason. */
  async function receiptProblem(chain, rec, facts) {
    const s = await chain.snapshot((c) => c.getTransactionReceipt({ hash: rec.hash }));
    const r = s.value;
    if (!r) return "no receipt";
    if (r.status !== "success") return `receipt status ${r.status}`;
    if (lc(r.from) !== lc(sender) || lc(r.to) !== lc(MULTICALL3)) return "receipt sender or recipient differs";
    const want = new Map(rows.map((x) => [x.id, x]));
    const seen = new Set();
    for (const log of r.logs || []) {
      if (lc(log.address) !== lc(RESERVE)) continue;
      let ev;
      try { ev = decodeEventLog({ abi: DEPOSITED_ABI, data: log.data, topics: log.topics }); } catch { return "an unexpected reserve event in the receipt"; }
      const id = lc(ev.args.id), row = want.get(id);
      if (!row) return `a deposit to an unplanned deployment ${id.slice(0, 10)}`;
      if (seen.has(id)) return `a second deposit to ${id.slice(0, 10)}`;
      if (lc(ev.args.owner) !== lc(row.currentOwner)) return `${id.slice(0, 10)} was credited to ${ev.args.owner}, not ${row.currentOwner}`;
      if (lc(ev.args.from) !== lc(MULTICALL3) || BigInt(ev.args.amountWei) !== AMOUNT_WEI) return `${id.slice(0, 10)}: payer or amount differs`;
      seen.add(id);
    }
    if (seen.size !== rows.length) return `${rows.length - seen.size} planned deposit(s) missing from the receipt`;
    facts.receipt = { hash: rec.hash, block: String(r.blockNumber), deposits: seen.size, verifiedAtBlock: String(s.blockNumber) };
    return null;
  }

  async function check(chain) {
    if (Number(chain.chainId) !== CHAIN_ID) throw new Error("wrong chain");
    const perHost = new Map();
    const origin = (c) => chain.peers.find((p) => p.client === c)?.origin;
    const s = await chain.snapshot(async (c, blockNumber) => {
      const at = { blockNumber };
      const rd = (address, abi, functionName, args = []) => c.readContract({ address, abi, functionName, args, ...at });
      const [mc, rc, lcode, paused, balance] = await Promise.all([c.getCode({ address: MULTICALL3, ...at }), c.getCode({ address: RESERVE, ...at }),
        c.getCode({ address: LEDGER, ...at }), rd(RESERVE, OWNER_ABI, "paused"), c.getBalance({ address: sender, ...at })]);
      const out = [];
      for (const r of rows) {
        const d = await rd(LEDGER, LEDGER_ABI, "get", [r.id]);
        const [rv, blocked, cat] = await Promise.all([rd(RESERVE, OWNER_ABI, "reserveOf", [r.id, d.owner]), rd(RESERVE, OWNER_ABI, "blockedDeployment", [r.id]),
          catalogLabel(c, blockNumber, d.appRef)]);
        out.push({ id: r.id, ledgerId: lc(d.id), owner: lc(d.owner), active: d.active, enabled: rv.enabled, blocked, balanceWei: String(rv.balanceWei), label: cat.label });
      }
      const v = { multicall3CodeHash: codeHashOf(mc), reserveCodeHash: codeHashOf(rc), ledgerCodeHash: codeHashOf(lcode), reservePaused: paused,
        senderBalanceWei: String(balance), rows: out };
      const o = origin(c); if (o) perHost.set(o, { hash: (await c.getBlock(at)).hash, v: canonical(v) });   // per-host record, outside the agreement key
      return v;
    });
    const block = { number: s.blockNumber, hash: s.blockHash, agreeing: s.agreeing, peers: s.peers };
    const v = s.value, agreed = canonical(v);
    const hosts = [...perHost].filter(([, x]) => x.v === agreed && x.hash === s.blockHash).map(([o]) => o);
    const facts = { rows: v.rows.map((x) => ({ id: x.id, label: x.label, creditedOwner: x.owner, balanceWei: x.balanceWei })), totalWei: String(total),
      senderBalanceWei: v.senderBalanceWei, multicall3CodeHash: v.multicall3CodeHash, hosts };
    const blocked = (reason) => ({ state: "blocked", reason, block, facts });
    const prior = priorIntents();
    if (prior.state === "foreign") return blocked(`another batch top-up intent ${prior.rec.id} (${prior.rec.state}) exists for this sender: a batch is never paid twice`);
    if (prior.state === "confirmed") {
      const p = await receiptProblem(chain, prior.rec, facts);
      return p ? blocked(`intent ${prior.rec.id} is confirmed but its receipt does not prove the planned deposits (${p}); investigate before anything else`) : { state: "done", block, facts };
    }
    const evidence = { format: EVIDENCE_FORMAT, chainId: CHAIN_ID, collectedAt: new Date(now()).toISOString(),
      reads: hosts.map((rpc) => ({ rpc, chainId: CHAIN_ID, blockNumber: String(s.blockNumber), blockHash: s.blockHash, timestamp: String(Math.floor(s.timestamp / 1000)),
        multicall3CodeHash: v.multicall3CodeHash, reserveCodeHash: v.reserveCodeHash, ledgerCodeHash: v.ledgerCodeHash, reservePaused: v.reservePaused,
        rows: v.rows.map(({ label, ...x }) => x) })) };
    let proposal;
    try { proposal = buildProposal({ manifest, evidence, expectedMulticall3CodeHash: multicall3CodeHash, expectTotalWei: String(total), now: now() }); }
    catch (e) { if (e instanceof Refusal) return blocked(e.message); throw e; }
    verifyProposal(proposal);
    facts.dataSha256 = proposal.dataSha256;
    if (BigInt(v.senderBalanceWei) < total + BigInt(maxFeeWeiAllowance)) return blocked("the sender's balance does not cover the deposits plus the fee allowance");
    return { state: "ready", block, facts, tx: { to: proposal.to, data: proposal.data, value: BigInt(proposal.value) } };
  }

  return { id, from: sender, chainId: CHAIN_ID, manifestSha256: manifestSha,
    summary: { title: `Optional lease-gas top-up: ${rows.length} app reserves, ${formatEther(total)} ETH in one all-or-nothing transaction` },
    steps: [{ id: "batch-deposit", title: `Deposit ${formatEther(AMOUNT_WEI)} ETH into each of ${rows.length} app lease-gas reserves (one transaction)`, links: [], check,
      effects: (facts) => [
        `Calls canonical Multicall3 ${MULTICALL3}.aggregate3Value with ${rows.length} deposit(bytes32) calls on the lease-gas reserve ${RESERVE}, allowFailure false on every call: if any deposit fails, the whole transaction reverts and nothing is paid.`,
        `Total value ${formatEther(total)} ETH (${total} wei), exactly ${formatEther(AMOUNT_WEI)} ETH per app; Base network fees are additional. The storage adapter 0x7ae476a3 is not included.`,
        "Each deposit credits the deployment's CURRENT ledger owner at execution. No approval, withdrawal, configuration, ownership, catalog, version or administrator change is included.",
        ...(facts?.rows || rows.map((r) => ({ id: r.id, label: r.label, creditedOwner: r.currentOwner, balanceWei: "?" })))
          .map((x) => `${x.id.slice(0, 10)}… ${x.label}: credited to ${x.creditedOwner}; reserve now ${formatEther(BigInt(x.balanceWei === "?" ? 0 : x.balanceWei))} ETH`),
        ...(facts?.dataSha256 ? [`Call data sha256 ${facts.dataSha256}; checked at a fresh agreed block before preparing and again before the wallet is asked.`] : []),
        ...(facts?.receipt ? [`Verified receipt ${facts.receipt.hash}: ${facts.receipt.deposits} deposits, each to its planned owner.`] : []),
      ] }] };
}
