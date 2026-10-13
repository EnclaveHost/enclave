#!/usr/bin/env node
// migrate-ledger-delegates.mjs - cut the deployments ledger over to rev 15d: the LIVE rev 15 source
// plus owner-approved delegates (deploy/ledger/EnclaveDeployments.sol; docs/design/sessions.md §16),
// together with the two contracts bound to the ledger's address: the proof-of-time prover and the
// verification-fee router.
//
//   prepare   MIGRATOR only, live untouched: deploy ledger 15d with the live constructor arguments,
//             copy every live owner parameter, deploy + bind a fresh prover and fee router, import
//             every record through the admin console's own migration engine (delta, resumable),
//             verify field by field. Imports stay OPEN.
//   cutover   after GOVERNANCE has retired the old ledger (no record can change on it any more):
//             final delta import, verify, seal, offer ownership of the ledger and the prover to
//             governance, and write every remaining governance call as calldata (state file).
//   status    what is deployed, imported, sealed, owned and pointed at.
//
// Options: --rpc URL (default https://mainnet.base.org; a fork for the rehearsal - the engine's
//          own RPC list is redirected to it), --state FILE (default ./ledger-cutover.json),
//          --governance 0x… (default the book's owner), and the migrator key from
//          ENCLAVE_MIGRATOR_KEY or --key-file (never generated or printed here).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, http, fallback, encodeFunctionData, encodeDeployData, getAddress,
  toFunctionSelector, stringToHex, decodeFunctionResult } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const REPO = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const CMD = argv[0];
const RPC = flag("--rpc", "https://mainnet.base.org");
const STATE = flag("--state", "ledger-cutover.json");
const die = (m) => { console.error("error: " + m); process.exit(1); };
const say = (m) => console.log(m);
const eq = (a, b) => String(a || "").toLowerCase() === String(b || "").toLowerCase();
if (!["prepare", "cutover", "status"].includes(CMD)) die("usage: migrate-ledger-delegates.mjs prepare|cutover|status [--rpc URL] [--state FILE] [--governance 0x…]");

const BOOK = "0xab214342d5A490150A4A977063A2f88E21F80907";
const MAX_TX_GAS = 15_000_000n;

// the engine reads through site/js/core/chain.js's fixed public RPC list: send it to --rpc instead
if (RPC !== "https://mainnet.base.org") {
  const real = globalThis.fetch;
  // (and without the engine's 8 s abort: a cold fork fetches every slot from upstream on first touch)
  globalThis.fetch = (url, opts) => (opts?.method === "POST" && /base|drpc|publicnode|llamarpc|blast/i.test(String(url))
    ? real(RPC, { ...opts, signal: undefined }) : real(url, opts));
}
const MIG = await import(path.join(REPO, "site/components/admin-console/migrate.js"));
const { CONTRACTS } = await import(path.join(REPO, "site/js/gen/contract-artifacts.js"));
const kind = MIG.MIG_KINDS.deployments;

// mainnet: rotate over public RPCs (each rate-limits a burst of reads); a fork: just the fork
const pub = createPublicClient({ chain: base, transport: RPC === "https://mainnet.base.org"
  ? fallback(["https://mainnet.base.org", "https://base.drpc.org", "https://base-rpc.publicnode.com"].map((u) => http(u, { retryCount: 4, retryDelay: 1500 })))
  : http(RPC, { retryCount: 6 }) });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");

const fn = (name, inputs = [], outputs = []) => ({ type: "function", name, stateMutability: outputs.length ? "view" : "nonpayable",
  inputs: inputs.map((type) => ({ type })), outputs: outputs.map((type) => ({ type })) });
const BOOK_ABI = [fn("addr", ["bytes32"], ["address"]), fn("owner", [], ["address"]), fn("setMany", ["bytes32[]", "address[]"])];
const key = (s) => stringToHex(s, { size: 32 });
const bookAddr = (k) => pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "addr", args: [key(k)] });

// ---- the ledger 15d build: solc-js exactly as scripts/build-contract-artifacts.mjs builds a ledger ----
function compileLedger() {
  const solc = createRequire(path.join(REPO, "package.json"))("solc");
  const file = "EnclaveDeployments.sol";
  const input = { language: "Solidity", sources: { [file]: { content: fs.readFileSync(path.join(REPO, "deploy/ledger", file), "utf8") } },
    settings: { optimizer: { enabled: true, runs: 1 }, viaIR: true,
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "storageLayout"] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) die("solc: " + errs.map((e) => e.formattedMessage).join("\n"));
  const c = out.contracts[file].EnclaveDeployments;
  const runtime = c.evm.deployedBytecode.object.length / 2;
  if (runtime > 24576) die(`ledger 15d is ${runtime} B, over EIP-170`);
  const slot = c.storageLayout.storage.find((v) => v.label === "isDelegate")?.slot;
  return { abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, runtime, solc: solc.version(), delegateSlot: Number(slot) };
}

// every selector the migration engine sends or reads must exist on the target, or the import is a silent no-op
function checkEngineSelectors(runtimeHex) {
  const s = CONTRACTS.EnclaveDeployments.sel;
  const need = ["importDeployments", "importFees", "importEarn", "importCaps", "sealImports", "count", "getPage", "feeOf",
    "earnOf", "capOf", "multicall", "fundEscrow", "setOwner", "acceptOwnership", "importsSealed"];
  const missing = need.filter((n) => !s[n] || !runtimeHex.includes("63" + s[n]));
  if (missing.length) die("the 15d build lacks selectors the migration engine uses: " + missing.join(", "));
}

const OWNER_PARAMS = [   // [getter, setter, args from the live value]
  ["maxGpuMilli", "setMaxGpuMilli", (v) => [v]],
  ["maxFeePerSec6", "setMaxFee", (v) => [v]],
  ["runnerBps", "setRunnerBps", (v) => [v]],
  ["leaseSec", "setLeaseSec", (v) => [v]],
  ["proofRequiredFrom", "setProofRequiredFrom", (v) => [v]],
];

async function migrator() {
  let k = (process.env.ENCLAVE_MIGRATOR_KEY || "").trim();
  const f = flag("--key-file");
  if (!k && f) k = fs.readFileSync(f, "utf8").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) die("no migrator key: set ENCLAVE_MIGRATOR_KEY or pass --key-file PATH");
  const account = privateKeyToAccount(k);
  const wallet = createWalletClient({ account, chain: base, transport: http(RPC, { retryCount: 6 }) });
  let nonce = await pub.getTransactionCount({ address: account.address, blockTag: "pending" });
  const send = async (label, req) => {
    let gas;
    try { gas = (await pub.estimateGas({ account: account.address, ...req })) * 5n / 4n; } catch (e) { die(`${label}: would revert - ${e.shortMessage || e.message}`); }
    if (gas > MAX_TX_GAS) gas = MAX_TX_GAS;
    const hash = await wallet.sendTransaction({ ...req, gas, nonce: nonce++ });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
    if (rc.status !== "success") die(`${label} reverted: ${hash}`);
    say(`  ✓ ${label} (${(Number(rc.gasUsed) / 1e6).toFixed(2)}M gas) ${hash}`);
    if (RPC === "https://mainnet.base.org") await new Promise((r) => setTimeout(r, 8000));   // public RPC nodes lag the receipt
    return rc;
  };
  return { account, send };
}

async function readParams(address, abi) {
  const out = {};
  for (const n of ["maxGpuMilli", "maxFeePerSec6", "runnerBps", "leaseSec", "proofRequiredFrom", "claimBond6", "bondExitDelay",
    "ethUsdFeed", "payout", "registry", "usdc", "prover", "feeRouter", "owner", "pendingOwner", "retired", "importsSealed"]) {
    let err;
    for (let i = 0; i < 4 && out[n] === undefined; i++) {
      try { out[n] = await pub.readContract({ address, abi, functionName: n }); }
      catch (e) { err = e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
    }
    if (out[n] === undefined) die(`could not read ${n} from ${address}: ${err?.shortMessage || err?.message}`);
  }
  return out;
}

async function importDelta(send, source, target) {
  const data = await kind.read(source);
  const have = await kind.read(target);
  const txs = kind.plan(data, have, {});
  say(`  ${kind.counts(data)} on the source; ${txs.length} import transaction(s) to send`);
  for (const [i, t] of txs.entries()) await send(`[${i + 1}/${txs.length}] ${t.label}`, { to: target, data: t.dataHex });
  const v = await kind.verify(data, target);
  say(`  verified ${v.ok}/${v.total}${v.bad.length ? " - MISMATCHED " + v.bad.join(", ") : ""}`);
  return v;
}

const PROOF_ABI = [fn("proofWindowSec", [], ["uint64"]), fn("setProofWindow", ["uint64"]), fn("deployments", [], ["address"]),
  fn("owner", [], ["address"]), fn("pendingOwner", [], ["address"]), fn("transferOwnership", ["address"]), fn("acceptOwnership")];

// ============================================================================
if (CMD === "status") {
  const L = compileLedger();
  say(`ledger 15d build: ${L.runtime} B (solc ${L.solc}), isDelegate slot ${L.delegateSlot}`);
  for (const k of ["deployments", "proofOfTime", "verificationFees"]) say(`book ${k.padEnd(17)} ${await bookAddr(k)}`);
  say(`state ${STATE}: ${JSON.stringify(state, null, 1)}`);
  if (state.ledger) say(`new ledger params: ${JSON.stringify(await readParams(state.ledger, L.abi), (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  process.exit(0);
}

const L = compileLedger();
say(`ledger 15d: ${L.runtime} B runtime (EIP-170 headroom ${24576 - L.runtime}), solc ${L.solc}, isDelegate slot ${L.delegateSlot}`);
const source = state.source || getAddress(await bookAddr("deployments"));
const governance = getAddress(flag("--governance") || await pub.readContract({ address: BOOK, abi: BOOK_ABI, functionName: "owner" }));
const live = await readParams(source, L.abi);
say(`source ${source} (retired ${live.retired}), governance ${governance}`);
const { account, send } = await migrator();
say(`migrator ${account.address}, ${(Number(await pub.getBalance({ address: account.address })) / 1e18).toFixed(6)} ETH`);
Object.assign(state, { source, governance, migrator: account.address, delegateSlot: L.delegateSlot });

if (CMD === "prepare") {
  if (live.retired) die("the source ledger is already retired: prepare runs BEFORE the cutover window");
  // 1. the ledger, with the live constructor arguments
  if (!state.ledger) {
    say("deploying ledger 15d…");
    const rc = await send("deploy ledger 15d", { data: encodeDeployData({ abi: L.abi, bytecode: L.bytecode,
      args: [live.usdc, live.payout, live.registry, live.ethUsdFeed] }) });
    state.ledger = getAddress(rc.contractAddress); save();
  }
  let code;
  for (let i = 0; i < 20 && !(code && code.length > 2); i++) {
    code = await pub.getCode({ address: state.ledger }).catch(() => undefined);
    if (!(code && code.length > 2)) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!(code && code.length > 2)) die(`no code at ${state.ledger} yet`);
  checkEngineSelectors(code.toLowerCase());
  if (!code.toLowerCase().includes("63" + toFunctionSelector("setDelegate(address,bool)").slice(2))) die("the target has no setDelegate");
  // 2. every owner parameter the live ledger carries
  const now = await readParams(state.ledger, L.abi);
  for (const [g, s, args] of OWNER_PARAMS)
    if (String(now[g]) !== String(live[g])) await send(`${s}(${live[g]})`, { to: state.ledger, data: encodeFunctionData({ abi: L.abi, functionName: s, args: args(live[g]) }) });
  if (String(now.claimBond6) !== String(live.claimBond6) || String(now.bondExitDelay) !== String(live.bondExitDelay))
    await send(`setClaimBond(${live.claimBond6}, ${live.bondExitDelay})`, { to: state.ledger,
      data: encodeFunctionData({ abi: L.abi, functionName: "setClaimBond", args: [live.claimBond6, live.bondExitDelay] }) });
  // 3. the prover, bound one-shot
  if (!state.proofOfTime) {
    say("deploying the prover…");
    const P = CONTRACTS.EnclaveProofOfTime;
    const ctorAbi = [{ type: "constructor", inputs: P.ctor.map((c) => ({ name: c.name, type: c.type })), stateMutability: "nonpayable" }];
    const rc = await send("deploy EnclaveProofOfTime", { data: encodeDeployData({ abi: ctorAbi, bytecode: P.bytecode, args: [state.ledger, live.registry] }) });
    state.proofOfTime = getAddress(rc.contractAddress); save();
  }
  const oldWindow = await pub.readContract({ address: live.prover, abi: PROOF_ABI, functionName: "proofWindowSec" });
  const newWindow = await pub.readContract({ address: state.proofOfTime, abi: PROOF_ABI, functionName: "proofWindowSec" });
  if (oldWindow !== newWindow) await send(`setProofWindow(${oldWindow})`, { to: state.proofOfTime, data: encodeFunctionData({ abi: PROOF_ABI, functionName: "setProofWindow", args: [oldWindow] }) });
  if (!eq(await pub.readContract({ address: state.ledger, abi: L.abi, functionName: "prover" }), state.proofOfTime))
    await send("ledger.setProver", { to: state.ledger, data: encodeFunctionData({ abi: L.abi, functionName: "setProver", args: [state.proofOfTime] }) });
  // 4. the verification-fee router, bound one-shot (its constructor checks the ledger/prover pair)
  if (!state.verificationFees) {
    say("deploying the verification-fee router…");
    const F = CONTRACTS.EnclaveVerificationFees;
    const ctorAbi = [{ type: "constructor", inputs: F.ctor.map((c) => ({ name: c.name, type: c.type })), stateMutability: "nonpayable" }];
    const rc = await send("deploy EnclaveVerificationFees", { data: encodeDeployData({ abi: ctorAbi, bytecode: F.bytecode, args: [state.ledger, state.proofOfTime] }) });
    state.verificationFees = getAddress(rc.contractAddress); save();
  }
  if (!eq(await pub.readContract({ address: state.ledger, abi: L.abi, functionName: "feeRouter" }), state.verificationFees))
    await send("ledger.setFeeRouter", { to: state.ledger, data: encodeFunctionData({ abi: L.abi, functionName: "setFeeRouter", args: [state.verificationFees] }) });
  // 5. every record (delta: resumable, and re-run right before the cutover)
  say("importing records…");
  const v = await importDelta(send, source, state.ledger);
  state.prepared = { at: new Date().toISOString(), verified: v.ok, total: v.total }; save();
  const after = await readParams(state.ledger, L.abi);
  const diffs = [...OWNER_PARAMS.map(([g]) => g), "claimBond6", "bondExitDelay", "ethUsdFeed", "payout", "registry", "usdc"]
    .filter((g) => String(after[g]) !== String(live[g]));
  if (diffs.length) die("parameters still differ from the live ledger: " + diffs.join(", "));
  say(`prepared: ${state.ledger} (prover ${state.proofOfTime}, fees ${state.verificationFees}); imports OPEN; ${v.ok}/${v.total} verified`);
  if (v.bad.length) process.exit(1);
  say("next: governance retires the old ledger (one-way), then run `cutover`.");
}

if (CMD === "cutover") {
  if (!state.ledger) die("run prepare first");
  if (!live.retired) die("the source ledger is not retired yet: governance must call retire() on it first (records could still change after the final import)");
  say("final delta import…");
  const v = await importDelta(send, source, state.ledger);
  if (v.bad.length || v.ok !== v.total) die("verification failed - NOT sealing; imports stay open");
  if (!(await pub.readContract({ address: state.ledger, abi: L.abi, functionName: "importsSealed" })))
    await send("sealImports (irreversible)", { to: state.ledger, data: encodeFunctionData({ abi: L.abi, functionName: "sealImports" }) });
  if (!eq(await pub.readContract({ address: state.ledger, abi: L.abi, functionName: "pendingOwner" }), governance)
      && !eq(await pub.readContract({ address: state.ledger, abi: L.abi, functionName: "owner" }), governance))
    await send("ledger.setOwner(governance)", { to: state.ledger, data: encodeFunctionData({ abi: L.abi, functionName: "setOwner", args: [governance] }) });
  if (!eq(await pub.readContract({ address: state.proofOfTime, abi: PROOF_ABI, functionName: "pendingOwner" }), governance)
      && !eq(await pub.readContract({ address: state.proofOfTime, abi: PROOF_ABI, functionName: "owner" }), governance))
    await send("prover.transferOwnership(governance)", { to: state.proofOfTime, data: encodeFunctionData({ abi: PROOF_ABI, functionName: "transferOwnership", args: [governance] }) });
  const escrow = await MIG.escrowPlan(state.ledger);
  state.governanceCalls = [
    { label: "accept the new ledger", to: state.ledger, data: encodeFunctionData({ abi: L.abi, functionName: "acceptOwnership" }) },
    { label: "accept the new prover", to: state.proofOfTime, data: encodeFunctionData({ abi: PROOF_ABI, functionName: "acceptOwnership" }) },
    ...(BigInt(escrow.total6) > 0n ? [
      { label: `approve ${Number(escrow.total6) / 1e6} USDC escrow backing`, to: live.usdc, data: MIG.approveTx(state.ledger, escrow.total6) },
      ...escrow.txs.map((t) => ({ label: t.label, to: state.ledger, data: t.dataHex })),
    ] : []),
    { label: "point the book at the new ledger, prover and fee router", to: BOOK, data: encodeFunctionData({ abi: BOOK_ABI, functionName: "setMany",
      args: [[key("deployments"), key("proofOfTime"), key("verificationFees")], [state.ledger, state.proofOfTime, state.verificationFees]] }) },
  ];
  state.escrow = { total6: escrow.total6, records: escrow.items.length, skipped: escrow.skipped.length };
  state.cutover = { at: new Date().toISOString(), verified: v.ok }; save();
  say(`sealed and offered to ${governance}. Governance calls (in order) written to ${STATE}:`);
  for (const c of state.governanceCalls) say(`  - ${c.label}: to ${c.to}`);
}
