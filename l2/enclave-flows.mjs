#!/usr/bin/env node
// enclave-flows.mjs - deploy Enclave's Registry, Ledger (EnclaveDeployments)
// and Catalog UNCHANGED from contracts/ onto an Enclave L2 devnet, prove the
// bytes are production's, and exercise publish -> approve -> register ->
// create -> fund -> claim -> renew (single and batched) -> release while
// recording every receipt's L2 gas and L1 data fee.
//
// Testnet tooling. It refuses a chain id that belongs to a production network
// and takes keys only from files (one hex key per <role>.key), never argv.
//
// Usage:
//   node l2/enclave-flows.mjs --rpc http://127.0.0.1:9545 --keys DIR --out evidence.json \
//        [--batch 8] [--base-rpc https://mainnet.base.org] [--reuse previous-evidence.json]
// Roles read from DIR: owner (stands in for the Trezor owner), publisher, user, runner.
// Each needs L2 ETH; owner also pays for the deploys.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import solc from "solc";
import { createPublicClient, createWalletClient, http, defineChain, encodeDeployData,
         encodeFunctionData, decodeEventLog, getAddress, keccak256, toHex, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { linkBytecode } from "../site/js/lib/contract-linker.js";

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const die = (m) => { console.error(`enclave-flows: ${m}`); process.exit(1); };
const RPC = opt("rpc") || die("--rpc required");
const KEYS = opt("keys") || die("--keys required");
const OUT = opt("out") || die("--out required");
const BATCH = Number(opt("batch", "8"));
const BASE_RPC = opt("base-rpc");
const PRODUCTION_CHAIN_IDS = new Set([1, 10, 8453, 42161, 137]);

// Production's pinned build settings (contracts/deployments/source-verification-base.json):
// the same compiler and optimizer as the Base contracts, so equal source gives equal bytes.
const VERIFY = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/deployments/source-verification-base.json"), "utf8"));
const PINS = JSON.parse(fs.readFileSync(path.join(REPO, "contracts/deployments/contract-pins-production-base.json"), "utf8")).contracts;
const BUILDS = {
  EnclaveRegistry:    { file: "EnclaveRegistry.sol",    build: "registry-schema4", pin: "registry" },
  EnclaveDeployments: { file: "EnclaveDeployments.sol", build: "ledger-rev16d",    pin: "deployments" },
  EnclaveAppCatalog:  { file: "EnclaveAppCatalog.sol",  build: "catalog",          pin: "appCatalog" },
};
if (!solc.version().startsWith(VERIFY.compiler.version.split("+")[0])) die(`solc ${solc.version()} != pinned ${VERIFY.compiler.version}`);

function compile(file, settings, dir = path.join(REPO, "contracts")) {
  const input = { language: "Solidity", sources: { [file]: { content: fs.readFileSync(path.join(dir, file), "utf8") } },
    settings: { ...settings, outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.bytecode.linkReferences",
      "evm.deployedBytecode.object", "evm.deployedBytecode.linkReferences", "evm.deployedBytecode.immutableReferences"] } } } };
  const find = (p) => {
    for (const base of [dir, path.join(REPO, "contracts")]) {
      const f = path.resolve(base, p);
      if (fs.existsSync(f)) return { contents: fs.readFileSync(f, "utf8") };
    }
    return { error: `not found: ${p}` };
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: find }));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) die(errs.map((e) => e.formattedMessage).join("\n"));
  return out.contracts;
}

// Mask the bytes a deployment legitimately varies in (immutables, linked library
// addresses), then compare runtime code. Equal masked code = same source + settings.
function maskRuntime(hex, refs) {
  // unlinked solc output carries __$hash$__ library placeholders, which are not hex
  const b = Buffer.from(hex.replace(/^0x/, "").replace(/__\$[0-9a-f]{34}\$__/g, "0".repeat(40)), "hex");
  for (const r of refs) b.fill(0, r.start, r.start + r.length);
  return keccak256(b);
}
function runtimeRefs(c) {
  const refs = [];
  for (const list of Object.values(c.evm.deployedBytecode.immutableReferences || {})) refs.push(...list);
  for (const libs of Object.values(c.evm.deployedBytecode.linkReferences || {}))
    for (const list of Object.values(libs)) refs.push(...list);
  return refs;
}

const key = (role) => {
  const f = path.join(KEYS, `${role}.key`);
  const k = fs.readFileSync(f, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) die(`${f} is not a hex private key`);
  return privateKeyToAccount(k);
};

const ev = { kind: "enclave.l2-devnet-flows", version: 1, startedAt: new Date().toISOString(), rpc: RPC, txs: [], checks: {} };
const save = () => fs.writeFileSync(OUT, JSON.stringify(ev, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");

const probe = createPublicClient({ transport: http(RPC) });
const chainId = await probe.getChainId();
if (PRODUCTION_CHAIN_IDS.has(chainId)) die(`chain ${chainId} is a production network; this tool is testnet-only`);
const chain = defineChain({ id: chainId, name: `enclave-l2-${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC) });
ev.chainId = chainId;
const actors = Object.fromEntries(["owner", "publisher", "user", "runner"].map((r) => [r, key(r)]));
ev.actors = Object.fromEntries(Object.entries(actors).map(([r, a]) => [r, a.address]));
const wallets = Object.fromEntries(Object.entries(actors).map(([r, a]) => [r, createWalletClient({ account: a, chain, transport: http(RPC) })]));

// Every receipt is kept raw: an OP Stack receipt carries the L1 data fee
// (l1Fee, l1GasUsed, l1GasPrice, l1BlobBaseFee and the scalars) next to gasUsed.
async function send(label, role, req) {
  const hash = req.data && !req.to
    ? await wallets[role].sendTransaction({ data: req.data })
    : await wallets[role].sendTransaction(req);
  await pub.waitForTransactionReceipt({ hash });
  const r = await pub.request({ method: "eth_getTransactionReceipt", params: [hash] });
  if (r.status !== "0x1") die(`${label} reverted (${hash})`);
  const row = { label, role, hash, block: Number(r.blockNumber), gasUsed: Number(r.gasUsed),
    effectiveGasPrice: BigInt(r.effectiveGasPrice).toString(), l2FeeWei: (BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)).toString(),
    l1FeeWei: r.l1Fee ? BigInt(r.l1Fee).toString() : null, l1GasUsed: r.l1GasUsed ? Number(r.l1GasUsed) : null,
    l1GasPrice: r.l1GasPrice ? BigInt(r.l1GasPrice).toString() : null, l1BlobBaseFee: r.l1BlobBaseFee ? BigInt(r.l1BlobBaseFee).toString() : null,
    contractAddress: r.contractAddress || null };
  ev.txs.push(row); save();
  console.log(`${label.padEnd(28)} gas=${String(row.gasUsed).padStart(8)} l1Fee=${row.l1FeeWei}  ${hash}`);
  return { ...row, logs: r.logs };
}
const call = (label, role, address, abi, functionName, args) =>
  send(label, role, { to: address, data: encodeFunctionData({ abi, functionName, args }) });
const event = (logs, abi, name) => {
  for (const l of logs) {
    try { const d = decodeEventLog({ abi, data: l.data, topics: l.topics }); if (d.eventName === name) return d.args; } catch {}
  }
  die(`no ${name} event`);
};

// ---- compile -----------------------------------------------------------------
const built = {};
for (const [name, b] of Object.entries(BUILDS)) {
  const v = VERIFY.builds[b.build];
  const settings = { optimizer: v.settings.optimizer, ...(v.settings.viaIR ? { viaIR: true } : {}) };
  const out = compile(b.file, settings)[b.file];
  built[name] = { ...out[name], settings, all: out };
  const sha = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(path.join(REPO, "contracts", b.file))).digest("hex");
  ev.checks[name] = { source: `contracts/${b.file}`, sourceSha256: sha, productionSourceSha256: v.sources[b.file].sha256,
    sourceMatchesProductionPin: sha === v.sources[b.file].sha256, settings };
}
const lib = built.EnclaveDeployments.all.EnclaveLedgerBandwidth;
// SessionMocks imports the ledger (IEnclaveRegistry), so it needs the ledger's viaIR settings to compile
const mocks = compile("SessionMocks.sol", { optimizer: { enabled: true, runs: 1 }, viaIR: true }, path.join(REPO, "contracts/foundry/test/mocks"));
const usdcArt = mocks["SessionMocks.sol"].MockUSDC3009;

// Optional: compare masked runtime code with what Base mainnet runs today.
if (BASE_RPC) {
  const base = createPublicClient({ transport: http(BASE_RPC) });
  for (const [name, b] of Object.entries(BUILDS)) {
    const code = await base.getCode({ address: PINS[b.pin] });
    const c = built[name];
    const refs = runtimeRefs(c);
    const ours = "0x" + c.evm.deployedBytecode.object;
    ev.checks[name].baseAddress = PINS[b.pin];
    ev.checks[name].baseRuntimeBytes = (code.length - 2) / 2;
    ev.checks[name].compiledRuntimeBytes = (ours.length - 2) / 2;
    // different lengths = different source (main has moved on from the pinned build)
    ev.checks[name].compiledMatchesBaseRuntime = code.length === ours.length && maskRuntime(code, refs) === maskRuntime(ours, refs);
  }
}
save();

// ---- deploy ------------------------------------------------------------------
const deploy = async (label, role, art, args = [], bytecode) => {
  const data = encodeDeployData({ abi: art.abi, bytecode: bytecode || ("0x" + art.evm.bytecode.object), args });
  const r = await send(label, role, { data });
  return getAddress(r.contractAddress);
};
const A = {};
A.usdc = await deploy("deploy MockUSDC3009", "owner", usdcArt);
A.registry = await deploy("deploy EnclaveRegistry", "owner", built.EnclaveRegistry);
A.ledgerLibrary = await deploy("deploy EnclaveLedgerBandwidth", "owner", lib);
const ledgerCode = linkBytecode("0x" + built.EnclaveDeployments.evm.bytecode.object, built.EnclaveDeployments.evm.bytecode.linkReferences,
  { "EnclaveDeployments.sol:EnclaveLedgerBandwidth": A.ledgerLibrary });
// payout = owner (the treasury stand-in); feed 0x0 = ETH funding off, as on the e2e chain
A.ledger = await deploy("deploy EnclaveDeployments", "owner", built.EnclaveDeployments,
  [A.usdc, actors.owner.address, A.registry, "0x0000000000000000000000000000000000000000"], ledgerCode);
A.catalog = await deploy("deploy EnclaveAppCatalog", "owner", built.EnclaveAppCatalog);
ev.addresses = A; save();

// The deployed runtime must equal the compiled runtime (same masking).
for (const [name, addr] of [["EnclaveRegistry", A.registry], ["EnclaveDeployments", A.ledger], ["EnclaveAppCatalog", A.catalog]]) {
  const c = built[name], refs = runtimeRefs(c);
  ev.checks[name].l2Address = addr;
  ev.checks[name].l2RuntimeMatchesCompiled = maskRuntime(await pub.getCode({ address: addr }), refs) === maskRuntime("0x" + c.evm.deployedBytecode.object, refs);
}
save();

const RG = built.EnclaveRegistry.abi, LG = built.EnclaveDeployments.abi, CT = built.EnclaveAppCatalog.abi, US = usdcArt.abi;

// ---- publish + approve -------------------------------------------------------
const CID = "bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy";   // CIDv1 of "hello world" (raw)
await call("catalog.publishVersion", "publisher", A.catalog, CT, "publishVersion",
  ["hello-l2", "Hello L2", "Enclave L2 devnet fixture", "1.0.0", CID, [0, 0, 64, 1], "", "", 0n]);
const appId = await pub.readContract({ address: A.catalog, abi: CT, functionName: "appIdOf", args: [actors.publisher.address, "hello-l2"] });
await call("catalog.setApproval (owner)", "owner", A.catalog, CT, "setApproval", [appId, 0n, 1]);
const appRef = `catalog://${appId}/0`;

// ---- host registers ----------------------------------------------------------
const endpoint = `https://l2-devnet-${chainId}.host.invalid`;
await call("registry.register", "runner", A.registry, RG, "register",
  [endpoint, "EnclaveHost/enclave", keccak256(toHex("devnet-measurement")), 100n, 0n, actors.runner.address]);
const enclaveId = await pub.readContract({ address: A.registry, abi: RG, functionName: "idOf", args: [endpoint] });
await call("registry.setPayoutWallet", "runner", A.registry, RG, "setPayoutWallet", [enclaveId]);

// ---- user creates + funds ----------------------------------------------------
await call("usdc.mint (mock)", "user", A.usdc, US, "mint", [actors.user.address, parseUnits("1000000", 6)]);
await call("usdc.approve ledger", "user", A.usdc, US, "approve", [A.ledger, 2n ** 255n]);
const ids = [];
for (let i = 0; i <= BATCH; i++) {
  const r = await call(i ? `ledger.create #${i}` : "ledger.create", "user", A.ledger, LG, "create",
    [appRef, 0, 100, 8080, "", true, "", "0x0000000000000000000000000000000000000000", 0n, 1000n]);
  const id = event(r.logs, LG, "Created").id;
  ids.push(id);
  await call(i ? `ledger.fund #${i}` : "ledger.fund", "user", A.ledger, LG, "fund", [id, parseUnits("100", 6)]);
}

// ---- runner claims + renews --------------------------------------------------
for (let i = 0; i < ids.length; i++) await call(i ? `ledger.claim #${i}` : "ledger.claim", "runner", A.ledger, LG, "claim", [ids[i], enclaveId]);
await call("ledger.renew (single)", "runner", A.ledger, LG, "renew", [ids[0]]);
if (BATCH > 0) {
  const calls = ids.slice(1).map((id) => encodeFunctionData({ abi: LG, functionName: "renew", args: [id] }));
  await call(`ledger.multicall renew x${calls.length}`, "runner", A.ledger, LG, "multicall", [calls]);
}
const d0 = await pub.readContract({ address: A.ledger, abi: LG, functionName: "get", args: [ids[0]] });
ev.checks.lease = { id: ids[0], runner: d0.runner, enclaveId, runnerMatches: d0.runner === enclaveId,
  leaseUntil: Number(d0.leaseUntil), leaseSec: Number(await pub.readContract({ address: A.ledger, abi: LG, functionName: "leaseSec" })) };
await call("ledger.release", "runner", A.ledger, LG, "release", [ids[0]]);
const d1 = await pub.readContract({ address: A.ledger, abi: LG, functionName: "get", args: [ids[0]] });
ev.checks.release = { leaseUntilAfter: Number(d1.leaseUntil), claimableAgain: await pub.readContract({ address: A.ledger, abi: LG, functionName: "claimable", args: [ids[0]] }) };

ev.deployments = ids; ev.appRef = appRef; ev.enclaveId = enclaveId; ev.finishedAt = new Date().toISOString();
save();
console.log(`\nwrote ${OUT}`);
