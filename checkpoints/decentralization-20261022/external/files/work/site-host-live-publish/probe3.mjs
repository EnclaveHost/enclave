#!/usr/bin/env node
// READ-ONLY probe 3 (public contract metadata only): what app-funded lease mode on minipc requires of the site
// deployment. No signature, no send, no API call. Writes logs/probe3.json.
//   - registry entries of minipc and metal0 (operator, payoutWallet, active, proofKey): decides claimPolicy and the rate;
//   - EnclaveHostOwnership 0xbbd885… authority of both hosts (the original owner-enrollment prerequisite);
//   - the reserve 0x12a3…: owner/pending, ledger/registry/oracle/executor binding, pause, limits, runtime code hashes
//     against the reviewed pins (work/lease-enrollment-signing/trust.mjs), executor.reserve();
//   - the reserve record of one existing admin-owned app on minipc (the enrolled policy pattern);
//   - the ledger's claim gates (retired, proofRequiredFrom, claimBond6, the minipc operator's bond);
//   - gas price, admin balance.
import fs from "node:fs";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const TREE = path.resolve(HERE, "../site-host-final-release/tree");
const { createPublicClient, http, parseAbi, keccak256 } = await import(path.join(TREE, "node_modules/viem/_esm/index.js"));
const { base } = await import(path.join(TREE, "node_modules/viem/_esm/chains/index.js"));
const { ENROLLMENT } = await import(path.resolve(HERE, "../lease-enrollment-signing/trust.mjs"));
const RPCS = ["https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base", "https://mainnet.base.org"];
const clients = RPCS.map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 15000, retryCount: 1 }) }));
const J = (v) => JSON.stringify(v, (k, x) => typeof x === "bigint" ? x.toString() : x);
async function q(fn, label) {
  const got = await Promise.allSettled(clients.map((c) => fn(c)));
  const t = new Map(); for (const g of got) if (g.status === "fulfilled") { const v = J(g.value); t.set(v, (t.get(v) || 0) + 1); }
  const best = [...t].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < 2) throw new Error(`${label}: no 2-RPC agreement`);
  return JSON.parse(best[0]);
}
const MINIPC = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a", METAL0 = "0x4dde6d1b33034333dd86f1f4cd5528b0118ad99c3f903e270ebeaf4533e068be";
const OWNERSHIP = "0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7", ADMIN = ENROLLMENT.admin, RESERVE = ENROLLMENT.reserve, EXECUTOR = ENROLLMENT.executor;
const REG = parseAbi(["function get(bytes32 id) view returns ((string endpoint, string repo, bytes32 measurement, address operator, uint64 registeredAt, uint64 lastSeen, bool active, uint64 cpuPricePerSec6, uint64 gpuPricePerSec6, address proofKey, address payoutWallet))"]);
const OWN = parseAbi(["function authority(bytes32) view returns (address owner, address pendingOwner, uint64 revision, bytes32 policyHash)"]);
const RES = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)", "function ledger() view returns (address)",
  "function registry() view returns (address)", "function l1Oracle() view returns (address)", "function executor() view returns (address)", "function paused() view returns (bool)",
  "function delegationCodeHash() view returns (bytes32)",
  "function limits() view returns (uint64 maxGasPriceCeiling, uint32 overheadClaimGas, uint32 overheadRenewGas, uint32 overheadReleaseGas, uint32 minClaimInterval, uint16 l1Bps)",
  "function reserveOf(bytes32 id, address owner_) view returns ((uint128 balanceWei, uint64 maxPerOpWei, uint64 epochCapWei, bool enabled, uint8 claimPolicy, bool sponsorRelease, uint32 renewWindow, uint32 minExtension, uint32 claimCooldown, uint32 epochSec, uint64 maxGasPrice, uint8 maxClaimsPerEpoch, uint32 epochIndex, uint96 epochSpentWei, uint8 epochClaims, uint64 lastClaimAt, address lastClaimOperator))",
  "function quote(bytes32 id, address owner_, uint8 kind, uint256 gasUsed, uint256 calldataLength, uint256 gasPrice, bool authorization) view returns (uint256 chargeWei, uint256 l1FeeWei)"]);
const EXE = parseAbi(["function reserve() view returns (address)"]);
const LED = parseAbi(["function retired() view returns (bool)", "function proofRequiredFrom() view returns (uint64)", "function claimBond6() view returns (uint256)",
  "function bondOf(address operator) view returns (uint256 amount6, uint64 exitAt)", "function leaseSec() view returns (uint64)",
  "function get(bytes32) view returns ((bytes32 id, address owner, string appRef, string ports, string configCid, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, bool isPublic, bool active, uint64 createdAt, uint256 rate, uint256 balance6, uint256 spent6, bytes32 runner, address runnerOperator, uint64 leaseUntil))"]);
const rd = (address, abi, functionName, args = []) => (c) => c.readContract({ address, abi, functionName, args });
const out = { at: new Date().toISOString(), readOnly: true, rpcs: RPCS, quorum: 2 };
out.block = await q((c) => c.getBlockNumber(), "block");
out.hosts = {};
for (const [name, id] of [["minipc", MINIPC], ["metal0", METAL0]]) {
  const e = await q(rd(ENROLLMENT.registry, REG, "get", [id]), "registry " + name);
  const a = await q(rd(OWNERSHIP, OWN, "authority", [id]), "ownership " + name);
  out.hosts[name] = { hostId: id, operator: e.operator, payoutWallet: e.payoutWallet, active: e.active, proofKey: e.proofKey, cpuPricePerSec6: e.cpuPricePerSec6,
    payoutIsAdmin: e.payoutWallet.toLowerCase() === ADMIN.toLowerCase(), hostOwnership: { contract: OWNERSHIP, owner: a[0], pendingOwner: a[1], revision: a[2], policyHash: a[3] },
    operatorBond: await q(rd(ENROLLMENT.ledger, LED, "bondOf", [e.operator]), "bond " + name) };
}
const codeHash = async (a) => keccak256(await q((c) => c.getCode({ address: a }), "code " + a));
const r = {};
for (const f of ["owner", "pendingOwner", "ledger", "registry", "l1Oracle", "executor", "paused", "delegationCodeHash", "limits"]) r[f] = await q(rd(RESERVE, RES, f), "reserve." + f);
out.reserve = { address: RESERVE, ...r, executorReserve: await q(rd(EXECUTOR, EXE, "reserve"), "executor.reserve"),
  runtimeHash: await codeHash(RESERVE), runtimeHashPinned: ENROLLMENT.reserveRuntimeHash, executorRuntimeHash: await codeHash(EXECUTOR), executorRuntimeHashPinned: ENROLLMENT.executorRuntimeHash,
  ledgerCodeHash: await codeHash(ENROLLMENT.ledger), ledgerCodeHashPinned: ENROLLMENT.codeHashes.ledger, registryCodeHash: await codeHash(ENROLLMENT.registry), registryCodeHashPinned: ENROLLMENT.codeHashes.registry,
  adminCode: await q((c) => c.getCode({ address: ADMIN }), "admin code") ?? "0x" };
// one enrolled admin-owned app that runs on minipc (the enrollment trust's list; runtime-preflight.json shows it running there)
const REF = "0xd9798e4ccd0c8402d0042000513fc6bc14616043d96dff3368080a21a1abbb9a";
const d = await q(rd(ENROLLMENT.ledger, LED, "get", [REF]), "ledger.get ref");
out.referenceApp = { id: REF, owner: d.owner, runner: d.runner, runnerOperator: d.runnerOperator, rate: d.rate, leaseUntil: d.leaseUntil,
  reserve: await q(rd(RESERVE, RES, "reserveOf", [REF, d.owner]), "reserveOf ref") };
out.ledgerGates = { retired: await q(rd(ENROLLMENT.ledger, LED, "retired"), "retired"), proofRequiredFrom: await q(rd(ENROLLMENT.ledger, LED, "proofRequiredFrom"), "proof"),
  claimBond6: await q(rd(ENROLLMENT.ledger, LED, "claimBond6"), "bond"), leaseSec: await q(rd(ENROLLMENT.ledger, LED, "leaseSec"), "leaseSec") };
out.gasPriceWei = await q((c) => c.getGasPrice(), "gas");
out.admin = { address: ADMIN, ethWei: await q((c) => c.getBalance({ address: ADMIN }), "admin eth") };
// what one sponsored claim and one renew would charge the reserve at the enrolled caps (upper-bound inputs)
const policyGas = BigInt(ENROLLMENT.policy.maxGasPrice);
out.quoteUpperBound = {};
for (const [kind, label] of [[1, "claim"], [2, "renew"]])
  out.quoteUpperBound[label] = await q(rd(RESERVE, RES, "quote", [REF, d.owner, kind, 400000n, 700n, policyGas, true]), "quote " + label);
fs.writeFileSync(path.join(HERE, "logs/probe3.json"), J(out) + "\n");
console.log(`probe3: minipc payout ${out.hosts.minipc.payoutWallet} (admin=${out.hosts.minipc.payoutIsAdmin}) owner ${out.hosts.minipc.hostOwnership.owner}; metal0 payout admin=${out.hosts.metal0.payoutIsAdmin} owner ${out.hosts.metal0.hostOwnership.owner}; reserve hash ok=${out.reserve.runtimeHash === out.reserve.runtimeHashPinned}; ref policy ${out.referenceApp.reserve.claimPolicy}`);
