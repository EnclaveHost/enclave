#!/usr/bin/env node
// READ-ONLY probe 4: the WHOLE owner sequence simulated as one eth_simulateV1 bundle (no signature, no send).
//   publishVersion (owner) -> create (owner) -> reserve.deposit -> reserve.configure -> reads:
//   catalog version, ledger record, reserveOf, reserve.statusOf(KIND_CLAIM, minipc, its operator), ledger.claimableBy.
// The deployment id is PREDICTED by eth_call of create from the owner: the ledger derives it as
// keccak256(owner, _nonces[owner]); only the owner's own creates move it, so it holds until the owner creates another.
// deposit/configure are built by the REVIEWED enrollment builder (work/lease-enrollment-signing/plan.mjs
// expectedOperations) over a trust DERIVED from the reviewed ENROLLMENT: same reserve/executor/admin/policy/gas caps, apps
// = [this deployment], no relays, perAppWei = the proposed deposit. Writes logs/probe4.json.
import fs from "node:fs";
import path from "node:path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const W = path.resolve(HERE, "..");
const { createPublicClient, http, encodeFunctionData, decodeFunctionResult, parseAbi, serializeTransaction, toHex } = await import(path.join(W, "enclave/node_modules/viem/_esm/index.js"));
const { base } = await import(path.join(W, "enclave/node_modules/viem/_esm/chains/index.js"));
const { ENROLLMENT } = await import(path.join(W, "lease-enrollment-signing/trust.mjs"));
const { expectedOperations } = await import(path.join(W, "lease-enrollment-signing/plan.mjs"));
const { verifiedArtifacts } = await import(path.join(W, "lease-gas-wallet-signing/artifacts.mjs"));
const { PRODUCTION } = await import(path.join(W, "lease-gas-wallet-signing/trust.mjs"));
const P1 = JSON.parse(fs.readFileSync(path.join(HERE, "logs/probe.json"), "utf8"));
const P2 = JSON.parse(fs.readFileSync(path.join(HERE, "logs/probe2.json"), "utf8"));
const reserveAbi = verifiedArtifacts({ trust: PRODUCTION }).EnclaveLeaseGasReserve.abi;     // provenance re-verified
const cliSrc = fs.readFileSync(path.join(W, "site-host-final-release/tree/cli/enclave.mjs"), "utf8");
const s = cliSrc.indexOf("const depsAbiFor = (tuple, rev) => ["), e = cliSrc.indexOf("\n];", s) + 3;
const createAbi = new Function(cliSrc.slice(s, e) + "; return depsAbiFor;")()([], 16).filter((f) => f.name === "create");

const ADMIN = ENROLLMENT.admin, LEDGER = ENROLLMENT.ledger, RESERVE = ENROLLMENT.reserve, CATALOG = P1.catalog.address;
const MINIPC = "0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a", MINIPC_OP = "0x1a01194c34fe3577c6d0a54feb78af6253e494e0";
const DEPOSIT_WEI = 1_000_000_000_000_000n;      // PROPOSED 0.001 ETH lease-gas deposit (not approved spending)
const CPU_MILLI = 50, MAX_RATE6 = 1n;
const envelope = JSON.stringify({ isolation: { require: "hyperv-partition-per-app" } });
const appRef = `catalog://${P1.catalog.appIdOfOwnerSlug}/0`;
const createArgs = [appRef, 0, CPU_MILLI, 8080, "", true, envelope, "0x0000000000000000000000000000000000000000", 0n, MAX_RATE6];
const createData = encodeFunctionData({ abi: createAbi, functionName: "create", args: createArgs });
const clients = ENROLLMENT.rpcs.map((u) => createPublicClient({ chain: base, transport: http(u, { timeout: 20000, retryCount: 1 }) }));
const READ = parseAbi(["function getVersion(bytes32 appId, uint256 index) view returns ((string cid, string version, uint32 vramMb, uint32 gpuGflops, uint32 memMb, uint32 cpuGflops, uint64 createdAt, bool verified, bool yanked, string ports, uint8 approval))",
  "function statusOf(bytes32 id, uint8 kind, bytes32 enclaveId, address operator) view returns (uint8 status, address owner)",
  "function claimableBy(bytes32 id, bytes32 enclaveId) view returns (bool)",
  "function get(bytes32) view returns ((bytes32 id, address owner, string appRef, string ports, string configCid, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, bool isPublic, bool active, uint64 createdAt, uint256 rate, uint256 balance6, uint256 spent6, bytes32 runner, address runnerOperator, uint64 leaseUntil))"]);
const ORACLE = parseAbi(["function getL1Fee(bytes) view returns (uint256)"]);
const J = (v) => JSON.stringify(v, (k, x) => typeof x === "bigint" ? x.toString() : x);
const out = { at: new Date().toISOString(), readOnly: true, rpcs: ENROLLMENT.rpcs, proposedDepositWei: String(DEPOSIT_WEI), perProvider: [] };
for (const [pi, c] of clients.entries()) {
  const block = await c.getBlockNumber({ cacheTime: 0 }) - 2n;
  const predicted = decodeFunctionResult({ abi: createAbi, functionName: "create", data: (await c.call({ account: ADMIN, to: LEDGER, data: createData, blockNumber: block })).data });
  const trust = { ...ENROLLMENT, apps: [[predicted, "admin", "enclave-site v1 (site-host)"]], relays: [], perAppWei: DEPOSIT_WEI, totalWei: DEPOSIT_WEI };
  const ops = expectedOperations(trust, reserveAbi);
  const call = (to, data, value = "0x0", gas = "0x1e8480") => ({ from: ADMIN, to, data, value, gas });
  const rd = (to, fn, args) => call(to, encodeFunctionData({ abi: READ, functionName: fn, args }));
  const calls = [call(CATALOG, P1.publishCall.data, "0x0", toHex(900000)), call(LEDGER, createData, "0x0", toHex(700000)),
    ...ops.map((o) => call(o.to, o.data, o.value, o.gas)),
    rd(CATALOG, "getVersion", [P1.catalog.appIdOfOwnerSlug, 0n]), rd(LEDGER, "get", [predicted]),
    call(RESERVE, encodeFunctionData({ abi: reserveAbi, functionName: "reserveOf", args: [predicted, ADMIN] })),
    rd(RESERVE, "statusOf", [predicted, 1, MINIPC, MINIPC_OP]), rd(LEDGER, "claimableBy", [predicted, MINIPC])];
  const res = (await c.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ calls }], validation: false }, toHex(block)] }))[0].calls;
  const ok = res.map((r) => r.status === "0x1");
  const n = 2 + ops.length;
  const version = decodeFunctionResult({ abi: READ, functionName: "getVersion", data: res[n].returnData });
  const record = decodeFunctionResult({ abi: READ, functionName: "get", data: res[n + 1].returnData });
  const reserve = decodeFunctionResult({ abi: reserveAbi, functionName: "reserveOf", data: res[n + 2].returnData });
  const [status] = decodeFunctionResult({ abi: READ, functionName: "statusOf", data: res[n + 3].returnData });
  const claimable = decodeFunctionResult({ abi: READ, functionName: "claimableBy", data: res[n + 4].returnData });
  // L1 data fee of each signed-size transaction (Base GasPriceOracle on a serialized unsigned tx; an estimate)
  const txs = [{ to: CATALOG, data: P1.publishCall.data, value: 0n }, { to: LEDGER, data: createData, value: 0n }, ...ops.map((o) => ({ to: o.to, data: o.data, value: BigInt(o.value) }))];
  const l1 = [];
  for (const [i, t] of txs.entries()) {
    const raw = serializeTransaction({ type: "eip1559", chainId: 8453, nonce: 1000, to: t.to, data: t.data, value: t.value, gas: BigInt(res[i].gasUsed) * 2n, maxFeePerGas: 100000000n, maxPriorityFeePerGas: 1000000n });
    l1.push(String(await c.readContract({ address: ENROLLMENT.oracle, abi: ORACLE, functionName: "getL1Fee", args: [raw], blockNumber: block })));
  }
  out.perProvider.push({ rpc: ENROLLMENT.rpcs[pi], block, predictedDeploymentId: predicted, allCallsSucceeded: ok.every(Boolean), callStatus: ok,
    gasUsed: { publishVersion: res[0].gasUsed, create: res[1].gasUsed, ...Object.fromEntries(ops.map((o, i) => [o.kind, res[2 + i].gasUsed])) }, l1FeeWei: l1,
    after: { version, record: { owner: record.owner, appRef: record.appRef, cpuMilli: record.cpuMilli, isPublic: record.isPublic, active: record.active, rate: record.rate, balance6: record.balance6, configCid: record.configCid },
      reserve, statusOfClaimOnMinipc: Number(status), statusMeaning: Number(status) === 0 ? "Ready" : "see Status enum", claimableByMinipc: claimable },
    operations: ops.map((o) => ({ kind: o.kind, title: o.title, from: o.from, to: o.to, value: o.value, gas: o.gas, data: o.data, policy: o.policy, opId: o.opId })) });
}
out.providersAgree = out.perProvider.length === 2 && J(out.perProvider[0].operations) === J(out.perProvider[1].operations) && out.perProvider[0].predictedDeploymentId === out.perProvider[1].predictedDeploymentId;
out.create = { to: LEDGER, data: createData, args: { appRef, gpuMilli: 0, cpuMilli: CPU_MILLI, appPort: 8080, ports: "", isPublic: true, configCid: envelope, feeRecipient: "0x0000000000000000000000000000000000000000", feePerSec6: "0", maxRate6: String(MAX_RATE6) } };
fs.writeFileSync(path.join(HERE, "logs/probe4.json"), J(out) + "\n");
const p = out.perProvider[0];
console.log(`probe4: agree=${out.providersAgree} id=${p.predictedDeploymentId} allOk=${out.perProvider.map((x) => x.allCallsSucceeded)} status=${out.perProvider.map((x) => x.statusOfClaimOnMinipc)} claimable=${out.perProvider.map((x) => x.claimableByMinipc)} gas=${J(p.gasUsed)}`);
