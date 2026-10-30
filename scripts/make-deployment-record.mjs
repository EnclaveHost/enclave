// Generate the reviewed lease-gas deployment record FROM THE CHAIN (never typed by hand), after a deployment:
//   node scripts/make-deployment-record.mjs --rpc https://a,https://b[,…] --reserve 0x… --pins ../enclave/contracts/deployments/contract-pins-base.json
//        [--chain-id 8453] [--l1-oracle 0x…] [--out lease-gas-record.json] --artifacts <forge out> [--sources contracts]
// Read-only. It refuses unless ALL of this holds at ONE anchor block that is at least two blocks deep on every RPC and
// whose hash every RPC still reports after the reads (no reorg in between):
//   - the RPCs are distinct providers (the repository's shared URL identity rule; plain http only with an explicit
//     loopback FIXTURE injection, never for a record to publish);
//   - the reserve's and the executor's RUNTIME code is EXACTLY the reviewed artifact with every immutable filled with
//     its expected value - executor: reserve = the reserve, ledger = the pinned ledger, SELF = the executor's own address;
//     reserve: ledger / registry = the pinned ones, l1Oracle = Base's GasPriceOracle (or --l1-oracle). The immutable map
//     comes from the compiler's immutableReferences, ordered by declaration in the reviewed source, whose keccak must
//     equal the artifact metadata's;
//   - reserve.executor() is bound (non-zero) and executor.reserve() points back; delegationCodeHash = keccak(0xef0100 || executor).
// Output: the record (enclave-lease-gas-deployment/v1) and its sha256 digest - the digest is what hosts, relays and
// owners pin (ENCLAVE_LEASE_GAS_DIGEST / LEASE_RELAY_DIGEST / --lease-gas-digest).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { createPublicClient, http, getAddress, keccak256, toHex, parseAbi, defineChain } from "viem";
import { rpcEndpoint } from "../network/rpc-identity.mjs";

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
export const BASE_L1_ORACLE = "0x420000000000000000000000000000000000000F";
const ZERO = "0x0000000000000000000000000000000000000000";
export const ABI = parseAbi(["function executor() view returns (address)", "function reserve() view returns (address)", "function ledger() view returns (address)",
  "function registry() view returns (address)", "function delegationCodeHash() view returns (bytes32)", "function owner() view returns (address)",
  "function limits() view returns (uint64,uint32,uint32,uint32,uint32,uint16)", "function l1Oracle() view returns (address)"]);
const SOURCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../contracts");
const CONTRACTS = { reserve: { file: "EnclaveLeaseGasReserve.sol", name: "EnclaveLeaseGasReserve" }, executor: { file: "EnclaveLeaseExecutor.sol", name: "EnclaveLeaseExecutor" } };

/** The reviewed artifact plus its immutable variables, by name, in declaration order. */
export function reviewed(which, { artifacts, sources = SOURCES } = {}) {
  if (!artifacts) throw new Error("name the reviewed forge artifacts (--artifacts <forge out>)");
  const c = CONTRACTS[which];
  const art = JSON.parse(fs.readFileSync(path.join(artifacts, c.file, c.name + ".json"), "utf8"));
  const meta = typeof art.rawMetadata === "string" ? JSON.parse(art.rawMetadata) : art.metadata;
  const key = Object.keys(meta.sources).find((k) => k.endsWith("/" + c.file) || k === c.file);
  const src = fs.readFileSync(path.join(sources, c.file), "utf8");
  if (!key || keccak256(toHex(src)) !== meta.sources[key].keccak256) throw new Error(`${c.file}: the reviewed source is not the artifact's (metadata keccak)`);
  const body = src.slice(src.indexOf(`contract ${c.name}`));
  const names = [...body.matchAll(/^\s*[\w.]+\s+(?:public\s+|private\s+|internal\s+)?immutable\s+(\w+)\s*;/gm)].map((m) => m[1]);
  const ids = Object.keys(art.deployedBytecode.immutableReferences || {}).map(Number).sort((a, b) => a - b);
  if (ids.length !== names.length) throw new Error(`${c.file}: ${ids.length} immutables in the artifact, ${names.length} in the source`);
  const refs = Object.fromEntries(names.map((n, i) => [n, art.deployedBytecode.immutableReferences[String(ids[i])]]));
  return { art, names, refs };
}
/** The exact runtime the reviewed artifact has with these immutable values (name -> address). */
export function expectedRuntime({ art, names, refs }, values) {
  const code = Buffer.from(art.deployedBytecode.object.replace(/^0x/, ""), "hex");
  for (const n of names) {
    if (!values[n]) throw new Error(`no expected value for immutable ${n}`);
    const word = Buffer.from(getAddress(values[n]).slice(2).padStart(64, "0"), "hex");
    for (const { start, length } of refs[n]) { if (length !== 32) throw new Error(`immutable ${n}: ${length}-byte slot`); word.copy(code, start); }
  }
  return "0x" + code.toString("hex");
}

/**
 * rpcs: production RPC URLs (distinct providers). fixtureClients: TEST ONLY - viem clients injected by a test against a
 * local chain; they are labelled as such in the evidence and never count as independent providers.
 */
export async function makeRecord({ rpcs, reserve, pins, chainId = 8453, l1Oracle = chainId === 8453 ? BASE_L1_ORACLE : null, artifacts,
  sources = SOURCES, fixtureClients = null, confirmations = 2 }) {
  let clients, providers;
  if (fixtureClients) { clients = fixtureClients; providers = clients.map((_, i) => `fixture-${i}`); }
  else {
    if (!Array.isArray(rpcs) || rpcs.length < 2) throw new Error("name at least two RPCs (--rpc a,b): every value must agree");
    const ids = new Map();
    for (const u of rpcs) {
      const e = rpcEndpoint(u);
      if (e.loopback) throw new Error(`${e.label}: a loopback RPC is a local fixture, not a provider for a record to publish`);
      if (ids.has(e.identity)) throw new Error(`RPCs ${ids.get(e.identity)} and ${e.label} are one provider (${e.identity}): name independent providers`);
      ids.set(e.identity, e.label);
    }
    providers = [...ids.values()];
    const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [] } } });
    clients = rpcs.map((u) => createPublicClient({ chain, transport: http(u, { retryCount: 0, timeout: 15_000 }) }));
  }
  if (!l1Oracle) throw new Error("name the expected L1 fee oracle (--l1-oracle): only Base's predeploy is known by default");
  const R = { reserve: reviewed("reserve", { artifacts, sources }), executor: reviewed("executor", { artifacts, sources }) };
  reserve = getAddress(reserve);
  const heads = await Promise.all(clients.map(async (c) => { if (await c.getChainId() !== chainId) throw new Error("an RPC is on another chain"); return c.getBlockNumber({ cacheTime: 0 }); }));
  const blockNumber = heads.reduce((m, x) => (x < m ? x : m)) - BigInt(confirmations);
  if (blockNumber < 0n) throw new Error("the chain is not deep enough for the confirmations");
  const reads = await Promise.all(clients.map(async (c) => {
    const blk = await c.getBlock({ blockNumber });
    const r = (address, functionName) => c.readContract({ address, abi: ABI, functionName, blockNumber });
    const executor = getAddress(await r(reserve, "executor"));
    if (executor === ZERO) return { blockHash: blk.hash, executor };
    const [rc, ec, back, ledger, registry, dch, admin, limits, oracle] = await Promise.all([c.getCode({ address: reserve, blockNumber }), c.getCode({ address: executor, blockNumber }),
      r(executor, "reserve"), r(reserve, "ledger"), r(reserve, "registry"), r(reserve, "delegationCodeHash"), r(reserve, "owner"), r(reserve, "limits"), r(reserve, "l1Oracle")]);
    return { blockHash: blk.hash, executor, rc, ec, back: getAddress(back), ledger: getAddress(ledger), registry: getAddress(registry), dch, admin: getAddress(admin),
      limits: limits.map(String), l1Oracle: getAddress(oracle) };
  }));
  const key = (x) => JSON.stringify(x);
  if (reads.some((x) => key(x) !== key(reads[0]))) throw new Error(`the RPCs disagree at block ${blockNumber}`);
  const v = reads[0];
  if (v.executor === ZERO) throw new Error("the reserve has no executor bound (bindExecutor not called, or not yet two blocks deep)");
  // the anchor is still canonical on every RPC, and still two blocks deep, after all the reads
  const after = await Promise.all(clients.map(async (c) => ({ hash: (await c.getBlock({ blockNumber })).hash, head: await c.getBlockNumber({ cacheTime: 0 }) })));
  if (after.some((a) => a.hash !== v.blockHash)) throw new Error(`block ${blockNumber} was replaced during the reads (reorg): run again`);
  if (after.some((a) => a.head < blockNumber + BigInt(confirmations))) throw new Error("an RPC's head fell below the anchor's confirmations");
  if (v.back !== reserve) throw new Error("the executor is bound to another reserve");
  if (v.ledger !== getAddress(pins.deployments) || v.registry !== getAddress(pins.registry)) throw new Error("the reserve is bound to another ledger or registry than the pinned ones");
  if (v.l1Oracle !== getAddress(l1Oracle)) throw new Error(`the reserve's L1 oracle ${v.l1Oracle} is not the expected ${l1Oracle}`);
  if (v.dch.toLowerCase() !== keccak256(`0xef0100${v.executor.slice(2)}`).toLowerCase()) throw new Error("delegationCodeHash is not 0xef0100 || executor");
  const want = {
    reserve: expectedRuntime(R.reserve, { ledger: pins.deployments, registry: pins.registry, l1Oracle }),
    executor: expectedRuntime(R.executor, { reserve, ledger: pins.deployments, SELF: v.executor }),
  };
  for (const [what, code] of [["reserve", v.rc], ["executor", v.ec]])
    if (!code || keccak256(code) !== keccak256(want[what])) throw new Error(`the ${what}'s runtime is not the reviewed artifact with its expected immutables (${R[what].names.join(", ")})`);
  const record = { format: "enclave-lease-gas-deployment/v1", chainId, reserve, executor: v.executor, reserveCodeHash: keccak256(v.rc), executorCodeHash: keccak256(v.ec),
    ledger: v.ledger, registry: v.registry };
  const bytes = Buffer.from(JSON.stringify(record));
  return { record, bytes, digest: "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex"),
    evidence: { block: Number(blockNumber), blockHash: v.blockHash, providers, fixture: !!fixtureClients, admin: v.admin, l1Oracle: v.l1Oracle, limits: v.limits,
      immutables: { reserve: R.reserve.names, executor: R.executor.names } } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pinsDoc = JSON.parse(fs.readFileSync(arg("--pins", "../enclave/contracts/deployments/contract-pins-base.json"), "utf8"));
  makeRecord({ rpcs: String(arg("--rpc", "")).split(",").filter(Boolean), reserve: arg("--reserve"), pins: pinsDoc.contracts || pinsDoc,
    chainId: Number(arg("--chain-id", "8453")), l1Oracle: arg("--l1-oracle") || undefined, artifacts: arg("--artifacts"), sources: arg("--sources", SOURCES) })
    .then(({ bytes, digest, evidence }) => {
      const out = arg("--out", "lease-gas-record.json");
      fs.writeFileSync(out, bytes);
      console.log(JSON.stringify({ wrote: out, digest, evidence }, null, 1));
    })
    .catch((e) => { console.error(`not written: ${e.message}`); process.exit(1); });
}
