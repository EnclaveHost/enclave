// queued-funding-small/review-small.mjs: copy of queued-funding-review/review.mjs 1ea28ff0 for the SMALL budget (0.0001 ETH per row, 0.001 ETH total):
// the small generator, the committed ./manifest.json (refused unless its ids/owners equal the fresh phase-A owners), and the
// simulation from the admin's ACTUAL balance (no override). READ-ONLY, unsigned.
// Public Base RPC reads, eth_call simulation and eth_estimateGas only. No wallet, key, signer, nonce, journal write, intent
// or broadcast. Reuses UNCHANGED: ens-outage-20261022/batch-topup-review/collect-evidence.mjs (the reviewed reader),
// batch-topup.mjs (parseManifest/checkEvidence/buildProposal/verifyProposal: pinned reserve+ledger code, 600 s freshness,
// >=2 distinct agreeing hosts, exact total, adapter excluded) and enclave/client/lease-executor-client.mjs quote().
// New here (read-only): the exact 10 ids are fixed; each CURRENT owner must be the admin EOA, or a SessionVault that the
// existing factory maps to the admin AND whose owner() is the admin (and whose code is an EIP-1167 clone); otherwise
// nothing is proposed. Labels are the live catalog name/version. Writes public JSON into this directory only.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = path.resolve(HERE, "../..");
const req = createRequire(path.join(W, "enclave/package.json"));
const viem = await import(req.resolve("viem"));
const { base } = await import(req.resolve("viem/chains"));
const { createPublicClient, http, keccak256, encodeFunctionData, decodeFunctionData, decodeFunctionResult, formatEther, getAddress } = viem;
const BT = await import(path.join(HERE, "batch-topup-small.mjs"));
const { collectEvidence } = await import(path.join(W, "ens-outage-20261022/batch-topup-review/collect-evidence.mjs"));
const { OWNER_ABI, LEDGER_ABI } = await import(path.join(W, "enclave/network/lease-gas-owner.mjs"));
const { quote } = await import(path.join(W, "enclave/client/lease-executor-client.mjs"));
const CATALOG_ABI = JSON.parse(fs.readFileSync(path.join(W, "enclave/contracts/EnclaveAppCatalog.abi.json"), "utf8"));

const ADMIN = "0x0b2d009c0c9Af05b12100D77F3c815fea822eE61";
const VAULT_FACTORY = "0x1F5c887c0cDF491b16AB6c449abAfDF9B2ec9C9C";      // SessionVaultFactory (contracts/deployments/ledger-15d-base.json)
const CATALOG = "0x18419CA2b502D423A8de6269AEeE171a378626e3";
const MC3_CODEHASH = "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891";   // ens-outage-20261022/multicall-code-review.json (4 reads, Base + Ethereum)
const TOTAL = "1000000000000000";
const RPCS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base-rpc.polkachu.com"];
const EIP1167 = /^0x363d3d373d3d3d363d73[0-9a-f]{40}5af43d82803e903d91602b57fd5bf3$/;
const VAULT_ABI = [{ type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }];
const FACTORY_ABI = [{ type: "function", name: "vaultFor", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] }];
const MC3_ABI = [{ type: "function", name: "aggregate3Value", stateMutability: "payable",
  inputs: [{ name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "allowFailure", type: "bool" }, { name: "value", type: "uint256" }, { name: "callData", type: "bytes" }] }],
  outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }] }];
const DEPOSIT_ABI = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [{ name: "id", type: "bytes32" }], outputs: [] }];
const lc = (s) => String(s).toLowerCase();
const J = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x), 2) + "\n";
const write = (n, v) => { fs.writeFileSync(path.join(HERE, n), typeof v === "string" ? v : J(v)); return n; };
const canon = (v) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? String(x) : x));
const t0 = new Date();

// the EXACT 10 ids: the reviewed proposed manifest, which must equal root's queued-recovery manifest ids
const prior = JSON.parse(fs.readFileSync(path.join(W, "ens-outage-20261022/batch-topup-review/proposed-manifest.json"), "utf8"));
const rootManifest = JSON.parse(fs.readFileSync(path.join(W, "root-queued-recovery-20261022/manifest.json"), "utf8"));
const IDS = prior.rows.map((r) => r.id);
if (IDS.length !== 10 || canon(IDS) !== canon(rootManifest.rows.map((r) => r.id))) throw new Error("the prior manifests do not name the same exact 10 ids");
if (IDS.some((id) => BT.EXCLUDED[id])) throw new Error("an excluded id is listed");

// JSON-RPC batching (fewer HTTP requests against the public rate limits); no retries, the agreement rules are unchanged
// ONE request at a time per endpoint (public RPCs reject concurrent/batched bursts from this shared IP); no retries; the
// agreement rules (>= 2 distinct hosts, identical answers at one block) are unchanged
const serial = (url) => { let q = Promise.resolve(), id = 0;
  return viem.custom({ request: ({ method, params }) => { const run = q.then(async () => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).hostname}`);
    const j = await r.json(); if (j.error) throw Object.assign(new Error(String(j.error.message)), { code: j.error.code, data: j.error.data });
    return j.result; }); q = run.catch(() => {}); return run; } }, { retryCount: 0 }); };
const clients = RPCS.map((url) => ({ url, client: createPublicClient({ chain: base, transport: serial(url) }) }));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- phase A: owners, owner provenance, labels, quotes, sender balance at ONE agreed block (all successful reads identical)
async function agreedBlock() {
  const heads = await Promise.allSettled(clients.map(async ({ client }) => { if (await client.getChainId() !== 8453) throw new Error("chain mismatch"); return client.getBlockNumber(); }));
  const live = heads.flatMap((h, i) => (h.status === "fulfilled" ? [{ i, head: h.value }] : []));
  if (live.length < 2) throw new Error("fewer than two RPCs answered");
  return { blockNumber: live.reduce((n, x) => (x.head < n ? x.head : n), live[0].head) - 2n, heads: heads.map((h, i) => ({ rpc: RPCS[i], head: h.status === "fulfilled" ? String(h.value) : null, error: h.status === "rejected" ? String(h.reason?.message || h.reason).slice(0, 120) : null })) };
}
const A = await agreedBlock();
const phaseA = await Promise.all(clients.map(async ({ url, client: c }) => {
  try {
    const at = { blockNumber: A.blockNumber };
    const rd = (address, abi, functionName, args = []) => c.readContract({ address, abi, functionName, args, ...at });
    const b = await c.getBlock(at);
    const gasPrice = (b.baseFeePerGas ?? 0n) + 1_000_000n;           // the same effective price as root's reserves-preflight-2252
    const fixed = { readContract: (x) => c.readContract({ ...x, ...at }) };
    const [renewQuote, claimQuote, senderBalance, vaultForAdmin] = await Promise.all([quote({ client: fixed, reserve: BT.RESERVE, kind: "renew", gasPrice }),
      quote({ client: fixed, reserve: BT.RESERVE, kind: "claim", gasPrice }), c.getBalance({ address: ADMIN, ...at }), rd(VAULT_FACTORY, FACTORY_ABI, "vaultFor", [ADMIN])]);
    const rows = [];
    for (const id of IDS) {
      const d = await rd(BT.LEDGER, LEDGER_ABI, "get", [id]);
      const rv = await rd(BT.RESERVE, OWNER_ABI, "reserveOf", [id, d.owner]);
      let owner = { kind: "admin EOA" };
      if (lc(d.owner) !== lc(ADMIN)) {
        const code = lc((await c.getCode({ address: d.owner, ...at })) || "0x");
        let vo = null; try { vo = await rd(d.owner, VAULT_ABI, "owner"); } catch {}
        owner = { kind: "contract", eip1167Clone: EIP1167.test(code), codeHash: keccak256(code), vaultOwner: vo, factoryVaultForAdmin: vaultForAdmin };
      }
      const m = /^catalog:\/\/(0x[0-9a-f]{64})\/(\d+)$/i.exec(d.appRef || "");
      let label = d.appRef;
      if (m) {
        const [app, ver] = await Promise.all([rd(CATALOG, CATALOG_ABI, "getApp", [m[1]]), rd(CATALOG, CATALOG_ABI, "getVersion", [m[1], BigInt(m[2])])]);
        label = { name: app.name, slug: app.slug, version: ver.version, appActive: app.active, yanked: ver.yanked, catalogApp: m[1], catalogVersion: m[2] };
      }
      rows.push({ id, ledgerId: lc(d.id), owner: d.owner, active: d.active, leaseUntil: d.leaseUntil, appRef: d.appRef, label, owner_: owner,
        enabled: rv.enabled, balanceWei: rv.balanceWei, maxPerOpWei: rv.maxPerOpWei });
    }
    return { rpc: url, blockHash: b.hash, timestamp: b.timestamp, gasPrice, renewQuote, claimQuote, senderBalance, vaultForAdmin, rows };
  } catch (e) { return { rpc: url, error: String(e?.shortMessage || e?.message || e).slice(0, 200) }; }
}));
const okA = phaseA.filter((r) => !r.error);
const hostsA = new Set(okA.map((r) => new URL(r.rpc).hostname));
const keyA = (r) => canon({ ...r, rpc: undefined });
const agreeA = okA.length >= 2 && hostsA.size >= 2 && okA.every((r) => keyA(r) === keyA(okA[0]));
const refusals = [];
if (!agreeA) refusals.push("phase A: fewer than two successful RPC reads, or the successful reads disagree (no quorum weakening: re-run)");
const a = okA[0];
const provenance = (a?.rows || []).map((r) => {
  let ok = false, why;
  if (r.ledgerId !== lc(r.id)) why = "the ledger does not know this id";
  else if (!r.active) why = "the deployment is not active";
  else if (lc(r.owner) === lc(ADMIN)) { ok = true; why = "current owner is the admin EOA"; }
  else if (r.owner_.eip1167Clone && lc(r.owner_.vaultOwner) === lc(ADMIN) && lc(r.owner_.factoryVaultForAdmin) === lc(r.owner)) { ok = true; why = "current owner is the admin's SessionVault (factory vaultFor(admin) == owner, vault.owner() == admin, EIP-1167 clone)"; }
  else why = `current owner ${r.owner} is neither the admin nor the admin's existing SessionVault: NOT credited`;
  if (!ok) refusals.push(`${r.id.slice(0, 10)}: ${why}`);
  return { id: r.id, owner: r.owner, credited: ok, why };
});
const label = (r) => typeof r.label === "object" ? `${String(r.label.name).slice(0, 40)} ${String(r.label.version).slice(0, 12)} (catalog ${r.label.catalogApp.slice(0, 8)} v${r.label.catalogVersion})`.slice(0, 80) : String(r.label).slice(0, 80);
write("phase-a-reads.json", { at: t0.toISOString(), block: String(A.blockNumber), heads: A.heads, agreeing: agreeA, hosts: [...hostsA].sort(), reads: phaseA });

let manifest = null, evidence = null, proposal = null, sim = null, inventory = null;
if (!refusals.length) {
  // ---- phase B: fresh manifest (current owners, live labels) -> the reviewed reader -> the reviewed generator
  const committed = JSON.parse(fs.readFileSync(path.join(HERE, "manifest.json"), "utf8"));
  const fresh = a.rows.map((r) => [lc(r.id), lc(r.owner)]);
  if (canon(committed.rows.map((r) => [lc(r.id), lc(r.currentOwner)])) !== canon(fresh)) refusals.push("the committed small manifest's ids/owners differ from the fresh phase-A owners");
  if (committed.rows.some((r) => r.amountWei !== String(BT.AMOUNT_WEI))) refusals.push("the committed small manifest is not 0.0001 ETH per row");
  const _unusedFreshShape = { format: BT.MANIFEST_FORMAT, chainId: 8453,
    note: `REFRESHED ${t0.toISOString()}: the same exact 10 ids as batch-topup-review/proposed-manifest.json and root-queued-recovery-20261022/manifest.json; currentOwner from the phase-A quorum read at block ${A.blockNumber}; labels are the live catalog name/version. 0.001 ETH each, 0.01 ETH total; the adapter 0x7ae476a3 excluded. PROPOSAL ONLY: no spending authority.`,
    rows: a.rows.map((r) => ({ id: r.id, currentOwner: getAddress(r.owner), amountWei: String(BT.AMOUNT_WEI), label: label(r) })) };
  manifest = committed;                                                  // exactly the manifest serve-small.mjs uses (its plan id)
  await pause(20_000);                                                   // let the public RPC rate windows recover between phases
  if (!refusals.length) evidence = await collectEvidence({ manifest, clients });
  write("batch-evidence.json", evidence);
  if (evidence) try { proposal = BT.buildProposal({ manifest, evidence, expectedMulticall3CodeHash: MC3_CODEHASH, expectTotalWei: TOTAL }); }
  catch (e) { refusals.push(`buildProposal: ${e.message}`); }
}
if (proposal) {
  write("batch-proposal.json", proposal);
  const verified = BT.verifyProposal(proposal);
  // independent decode, for the call inventory
  const { args } = decodeFunctionData({ abi: MC3_ABI, data: proposal.data });
  inventory = { to: proposal.to, value: proposal.value, selector: proposal.data.slice(0, 10), dataBytes: (proposal.data.length - 2) / 2, dataSha256: proposal.dataSha256,
    dataKeccak256: keccak256(proposal.data), verified,
    calls: args[0].map((c, i) => { const d = decodeFunctionData({ abi: DEPOSIT_ABI, data: c.callData });
      return { i, target: c.target, allowFailure: c.allowFailure, valueWei: String(c.value), callData: c.callData, function: `${d.functionName}(bytes32)`, id: d.args[0],
        creditedOwner: proposal.rows[i].creditedOwner, label: proposal.rows[i].label }; }) };
  // ---- phase C: simulation FROM the admin with the exact value, at the evidence block AND latest; gas estimate; fees
  const evBlock = BigInt(proposal.evidence.blockNumber);
  await pause(10_000);
  const callArgs = { account: ADMIN, to: proposal.to, data: proposal.data, value: BigInt(proposal.value) };
  sim = await Promise.all(clients.map(async ({ url, client: c }) => {
    const one = async (blockTag) => {
      try {
        const r = await c.call({ ...callArgs, ...(typeof blockTag === "bigint" ? { blockNumber: blockTag } : { blockTag }) });
        const out = decodeFunctionResult({ abi: MC3_ABI, functionName: "aggregate3Value", data: r.data });
        return { ok: true, results: out.length, allSuccess: out.every((x) => x.success === true) };
      } catch (e) { return { ok: false, error: String(e?.shortMessage || e?.message || e).slice(0, 200) }; }
    };
    try {
      const [atEvidence, atLatest, gas, latest, prio, bal] = await Promise.all([one(evBlock), one("latest"),
        c.estimateGas(callArgs).then((g) => ({ ok: true, gas: g }), (e) => ({ ok: false, error: String(e?.shortMessage || e?.message || e).slice(0, 200) })),
        c.getBlock({ blockTag: "latest" }), c.estimateMaxPriorityFeePerGas().catch(() => null), c.getBalance({ address: ADMIN, blockTag: "latest" })]);
      return { rpc: url, latestBlock: latest.number, latestTimestamp: latest.timestamp, baseFeePerGas: latest.baseFeePerGas, maxPriorityFeePerGas: prio, adminBalanceLatestWei: bal,
        callAtEvidenceBlock: atEvidence, callAtLatest: atLatest, estimateGas: gas };
    } catch (e) { return { rpc: url, error: String(e?.shortMessage || e?.message || e).slice(0, 200) }; }
  }));
  write("simulation.json", { at: new Date().toISOString(), from: ADMIN, to: proposal.to, valueWei: proposal.value, dataSha256: proposal.dataSha256, evidenceBlock: proposal.evidence.blockNumber, results: sim });
  write("call-inventory.json", inventory);
}

// ---- summary: balances, runway, affordability, staleness, journals (read-only scan of the existing deposit journal)
const journalDir = path.join(W, "ens-outage-20261022/deposit-journal");
const journal = fs.readdirSync(journalDir).filter((f) => /^tx-.*\.json$/.test(f)).map((f) => { const x = JSON.parse(fs.readFileSync(path.join(journalDir, f), "utf8")); return { file: f, state: x.state, nonce: x.nonce, to: x.to, value: x.value, hash: x.hash }; });
const okSim = (sim || []).filter((r) => !r.error);
const gasMax = okSim.reduce((m, r) => (r.estimateGas?.ok && r.estimateGas.gas > m ? r.estimateGas.gas : m), 0n);
const baseMax = okSim.reduce((m, r) => ((r.baseFeePerGas ?? 0n) > m ? r.baseFeePerGas : m), 0n);
const prioMax = okSim.reduce((m, r) => ((r.maxPriorityFeePerGas ?? 0n) > m ? r.maxPriorityFeePerGas : m), 0n);
const balMin = okSim.reduce((m, r) => (m === null || r.adminBalanceLatestWei < m ? r.adminBalanceLatestWei : m), null);
const feeLikely = gasMax * (baseMax + prioMax);
const feeCeiling = 1_200_000n * 100_000_000n;                          // root-queued-recovery serve.mjs: gasCap 1.2M x maxFeeGwei 0.1 = its 1.2e14 allowance
const evTs = proposal ? Number(proposal.evidence.timestamp) : null;
const summary = {
  at: new Date().toISOString(), startedAt: t0.toISOString(), status: refusals.length ? "REFUSED (see refusals)" : "PROPOSAL ONLY: unsigned; no wallet, nonce, intent or broadcast; spending pending the user's signature",
  refusals, ids: IDS, ownerProvenance: provenance,
  multicall3: { address: BT.MULTICALL3, expectedCodeHash: MC3_CODEHASH, source: "ens-outage-20261022/multicall-code-review.json (Base x2 + Ethereum x2, identical)",
    reReadInEvidence: evidence ? [...new Set(evidence.reads.filter((r) => !r.error).map((r) => r.multicall3CodeHash))] : null },
  phaseA: { block: String(A.blockNumber), agreeing: agreeA, hosts: [...hostsA].sort(), errors: phaseA.filter((r) => r.error).map((r) => ({ rpc: r.rpc, error: r.error })),
    renewQuoteWei: a?.renewQuote, claimQuoteWei: a?.claimQuote, adminBalanceWei: a?.senderBalance,
    rows: (a?.rows || []).map((r) => ({ id: r.id, label: label(r), owner: r.owner, enabled: r.enabled, active: r.active, leaseUntil: r.leaseUntil, leaseExpiredAtBlock: r.leaseUntil <= a.timestamp,
      balanceWei: r.balanceWei, claimAffordableNow: r.balanceWei >= a.claimQuote, renewAffordableNow: r.balanceWei >= a.renewQuote,
      afterDepositWei: r.balanceWei + BT.AMOUNT_WEI, afterRenewUnits: (r.balanceWei + BT.AMOUNT_WEI) / a.renewQuote, maxPerOpWei: r.maxPerOpWei })) },
  evidence: proposal ? { block: proposal.evidence.blockNumber, blockHash: proposal.evidence.blockHash, timestamp: proposal.evidence.timestamp, hosts: proposal.evidence.hosts,
    ageSecAtProposal: Math.floor(Date.now() / 1000) - evTs, mustBeAtMostSec: BT.DEFAULT_MAX_AGE_SEC,
    errors: evidence.reads.filter((r) => r.error).map((r) => ({ rpc: r.rpc, error: r.error })) } : null,
  proposal: proposal ? { to: proposal.to, valueWei: proposal.value, valueEth: formatEther(BigInt(proposal.value)), dataSha256: proposal.dataSha256, dataKeccak256: inventory.dataKeccak256, calls: inventory.calls.length } : null,
  simulation: sim ? sim.map((r) => r.error ? { rpc: r.rpc, error: r.error } : { rpc: r.rpc, atEvidence: r.callAtEvidenceBlock, atLatest: r.callAtLatest, estimateGas: r.estimateGas?.ok ? String(r.estimateGas.gas) : r.estimateGas?.error }) : null,
  affordability: sim ? { adminBalanceLatestMinWei: balMin, valueWei: TOTAL, estimatedGasMax: gasMax, baseFeeMaxWei: baseMax, priorityFeeMaxWei: prioMax,
    likelyFeeWei: feeLikely, likelyFeeEth: formatEther(feeLikely), bridgeFeeAllowanceWei: feeCeiling,
    coversValuePlusLikelyFee: balMin !== null && balMin >= BigInt(TOTAL) + feeLikely, coversValuePlusBridgeAllowance: balMin !== null && balMin >= BigInt(TOTAL) + feeCeiling } : null,
  rootManifestComparison: manifest ? { sameIds: true, sameOwners: canon(manifest.rows.map((r) => lc(r.currentOwner))) === canon(rootManifest.rows.map((r) => lc(r.currentOwner))),
    smallManifestSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(HERE, "manifest.json"))).digest("hex"),
    rootManifestSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(W, "root-queued-recovery-20261022/manifest.json"))).digest("hex") } : null,
  depositJournal: journal,
};
write("summary.json", summary);
console.log(canon({ status: summary.status, refusals, phaseA: { block: summary.phaseA.block, agreeing: agreeA }, evidence: summary.evidence && { block: summary.evidence.block, age: summary.evidence.ageSecAtProposal, hosts: summary.evidence.hosts },
  simulation: summary.simulation, affordability: summary.affordability, sameOwnersAsRootManifest: summary.rootManifestComparison?.sameOwners }));
if (refusals.length) process.exitCode = 2;
