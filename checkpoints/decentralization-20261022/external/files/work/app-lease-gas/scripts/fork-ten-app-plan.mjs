// Base-FORK run (local only; read-only public RPC, bounded): the actual owner CLI's no-default budget plan for the EXACT ten
// self-hosted inventory records, and a calibration of design B against the REAL deployed ledger (rev 16d) and registry
// (schema 4) bytecode and state and Base's native GasPriceOracle (0x42…0F) at one pinned block.
//
//   1. pick block = head - 64 agreed by two public RPCs; anvil --fork-url at that block (state fetched lazily, bounded);
//      verify the forked ledger/registry runtime code hashes equal the reviewed network profile's;
//   2. deploy EnclaveLeaseGasReserve(real ledger, real registry, 0x42…0F, limits) + EnclaveLeaseExecutor on the FORK;
//   3. run the ACTUAL CLI entry (shadow-cli/cli/enclave.mjs + dispatch hunk) with main's real contract pins:
//      `lease-gas plan --inventory <the inventory> ... ` once WITHOUT an amount (must refuse) and once with the owner's
//      choice given on this command line (--days / --per-app-eth; nothing defaulted), plus `lease-gas status`;
//   4. execute the printed requests on the fork as the owner of record (anvil impersonation: FORK-LOCAL fixture
//      authority, never a signature), then check every reserve;
//   5. calibration: a fork-local fixture host (new registry entry, owner's payout declaration by impersonation, 0 ETH)
//      claims one EXPIRED inventory record, renews it in the owner's window (fork clock moved), releases it, all through
//      a fork-local relay; per receipt: gas, the reserve's charge, the relay's L2 cost and the native oracle's L1 fee.
// Nothing is sent to Base. No real key, no signature of any real account. Outputs: plans/ten-app-cli-*.json,
// fixtures/base-fork-calibration.json.
//   usage (cwd work/app-lease-gas): node scripts/fork-ten-app-plan.mjs --days 30 --max-gas-price-gwei 0.05
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";
import { LEDGER_ABI } from "../network/lease-gas-owner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = path.resolve(ROOT, "../enclave");
const INVENTORY = path.resolve(ROOT, "../../outputs/storage-adapter-incident/self-hosted-inventory.json");
const PINS = path.join(MAIN, "contracts/deployments/contract-pins-base.json");
const PROFILE = JSON.parse(fs.readFileSync(path.join(MAIN, "contracts/deployments/network-profile-base.json"), "utf8"));
const CLI = path.join(ROOT, "shadow-cli/cli/enclave.mjs");
const RPCS = ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];
const ORACLE = "0x420000000000000000000000000000000000000F";
const DEPLOYER = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";   // anvil #0, fork-local only
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const AMOUNT = arg("--days") ? ["--days", arg("--days")] : arg("--per-app-eth") ? ["--per-app-eth", arg("--per-app-eth")] : null;
if (!AMOUNT) { console.error("name the owner's budget for this run: --days N or --per-app-eth X (there is no default)"); process.exit(2); }
const CAP_GWEI = arg("--max-gas-price-gwei");
if (!CAP_GWEI) { console.error("name the owner's gas price cap: --max-gas-price-gwei G"); process.exit(2); }
const L1_BPS = Number(arg("--l1-bps", "6500"));
const big = (_k, v) => (typeof v === "bigint" ? v.toString() : v);
const out = { at: new Date().toISOString(), readOnlyRpcs: RPCS, notSentToBase: true, inventory: { file: "outputs/storage-adapter-incident/self-hosted-inventory.json",
  sha256: crypto.createHash("sha256").update(fs.readFileSync(INVENTORY)).digest("hex") } };

// ---- 1. the fork block, agreed --------------------------------------------------------------------------------------
const rpc = async (url, method, params = []) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const t = await r.text(); if (t.length > 4 << 20) throw new Error("response too large");
  const j = JSON.parse(t); if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`); return j.result;
};
const heads = await Promise.all(RPCS.map((u) => rpc(u, "eth_blockNumber").then(BigInt)));
const forkBlock = (heads[0] < heads[1] ? heads[0] : heads[1]) - 64n;
const blocks = await Promise.all(RPCS.map((u) => rpc(u, "eth_getBlockByNumber", ["0x" + forkBlock.toString(16), false])));
if (blocks[0].hash !== blocks[1].hash) throw new Error("the public RPCs disagree on the fork block");
const prios = await Promise.all(RPCS.map((u) => rpc(u, "eth_maxPriorityFeePerGas").then(BigInt).catch(() => null)));
out.fork = { block: Number(forkBlock), hash: blocks[0].hash, timestamp: Number(BigInt(blocks[0].timestamp)), baseFeePerGas: BigInt(blocks[0].baseFeePerGas),
  liveMaxPriorityFeePerGasByRpc: Object.fromEntries(RPCS.map((u, i) => [u, prios[i]])) };
const livePrio = prios.filter((x) => x !== null).reduce((m, x) => (x > m ? x : m), 0n);

// ---- anvil fork + two pass-through origins (the CLI's quorum needs two). The ONLY rewrite: eth_maxPriorityFeePerGas is
// answered with the live Base value read above (anvil's own default is 1 gwei, ~1000x Base's market) --------------------
const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const port = await freePort();
const anvilUrl = `http://127.0.0.1:${port}`;
const FORK_RPC = RPCS[Number(arg("--fork-rpc", "0"))];   // which of the two read-only RPCs anvil fetches state from
out.fork = { ...out.fork, stateFetchedFrom: FORK_RPC };
const anvilErr = fs.openSync(path.join(ROOT, "logs/r3/anvil-fork-stderr.log"), "a");
const anvil = spawn("anvil", ["--fork-url", FORK_RPC, "--fork-block-number", String(forkBlock), "--chain-id", "8453", "--port", String(port), "--silent", "--no-mining",
  "--timeout", "20000", "--retries", "5", "--compute-units-per-second", "200"], { stdio: ["ignore", "ignore", anvilErr] });
const procs = [() => anvil.kill("SIGKILL")];
let anvilExited = null;
anvil.on("exit", (code, sig) => { anvilExited = `anvil exited (${code ?? sig})`; console.error(`[fork] ${anvilExited}: the fork is gone (a public RPC failure while fetching state?)`); });
const cleanup = () => { for (const p of procs) { try { p(); } catch {} } };
process.on("exit", cleanup);
for (let i = 0; i < 150; i++) { try { await rpc(anvilUrl, "eth_chainId"); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
// anvil continues a fork's clock from the fork block (minutes behind): align it to now ONCE, so the relay's and host's
// freshness bounds (120 s) judge the fork like a live chain. State and the oracle's L1 parameters stay the fork block's.
// CONTROLLED mining (--no-mining): every block is mined here, each at the fork block's REAL base fee (an automined block
// between timer ticks would decay it below Base's 0.005 gwei floor - root review 17:25Z C). Serialized.
const forkBaseFee = BigInt(blocks[0].baseFeePerGas);
let mining = Promise.resolve();
const mineOne = (ts = null) => (mining = mining.then(async () => {
  if (ts !== null) await rpc(anvilUrl, "evm_setNextBlockTimestamp", [ts]);
  await rpc(anvilUrl, "anvil_setNextBlockBaseFeePerGas", ["0x" + forkBaseFee.toString(16)]);
  await rpc(anvilUrl, "evm_mine");
}).catch(() => {}));
await mineOne(Math.floor(Date.now() / 1000));
out.fork.clockAlignedToWallTimeAtStart = true;
const proxies = [];
for (let i = 0; i < 2; i++) {
  const s = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
    let j = null; try { j = JSON.parse(b); } catch {}
    if (j && !Array.isArray(j) && j.method === "eth_maxPriorityFeePerGas") { res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: "0x" + livePrio.toString(16) })); }
    const r = await fetch(anvilUrl, { method: "POST", headers: { "content-type": "application/json" }, body: b });
    res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text()); }); });
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok));
  proxies.push(`http://127.0.0.1:${s.address().port}`);
  procs.push(() => { s.closeAllConnections(); s.close(); });
}
const chain = viem.defineChain({ id: 8453, name: "base-fork", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [anvilUrl] } } });
const pc = viem.createPublicClient({ chain, transport: viem.http(anvilUrl, { timeout: 120_000 }) });   // cold fork state is fetched lazily
const wc = (key) => viem.createWalletClient({ chain, account: privateKeyToAccount(key), transport: viem.http(anvilUrl) });
// keep blocks coming (relays and hosts refuse a stale head) at the FORK block's real base fee, not an empty-block decay
const miner = setInterval(() => mineOne(), 1000);   // a block a second, every one at the fork's base fee
procs.push(() => clearInterval(miner));
const send = async (key, tx) => { const h = await wc(key).sendTransaction(tx); const rc = await pc.waitForTransactionReceipt({ hash: h }); if (rc.status !== "success") throw new Error("reverted " + (tx.label || "")); return rc; };
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(ROOT, "forge/out", file, name + ".json"), "utf8")); return { abi: j.abi, bytecode: j.bytecode.object }; };
const deploy = async (a, args) => viem.getAddress((await send(DEPLOYER, { data: viem.encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) })).contractAddress);

// the forked contracts ARE the reviewed ones
const LEDGER = viem.getAddress(PROFILE.contracts.deployments.address), REGISTRY = viem.getAddress(PROFILE.contracts.registry.address);
for (const [name, a, want] of [["ledger", LEDGER, PROFILE.contracts.deployments.codeHash], ["registry", REGISTRY, PROFILE.contracts.registry.codeHash]]) {
  const h = viem.keccak256(await pc.getCode({ address: a }));
  if (h !== want) throw new Error(`forked ${name} code ${h} is not the reviewed ${want}`);
  out.fork[name] = { address: a, codeHash: h, matchesReviewedProfile: true };
}
const oracleCode = await pc.getCode({ address: ORACLE });
out.fork.gasPriceOracle = { address: ORACLE, codeHash: viem.keccak256(oracleCode), note: "the forked proxy's code; its L1 parameters are the fork block's L1Block state" };

// ---- 2. the reserve + executor on the fork --------------------------------------------------------------------------
await rpc(anvilUrl, "anvil_setBalance", [privateKeyToAccount(DEPLOYER).address, "0x56bc75e2d63100000"]);
const A = { reserve: art("EnclaveLeaseGasReserve.sol", "EnclaveLeaseGasReserve"), executor: art("EnclaveLeaseExecutor.sol", "EnclaveLeaseExecutor") };
// --overheads claim,renew,release: the reserve's per-kind overhead gas (admin Limits). Default: the LOCAL calibration
// (29.5k/24k/7k, test/lease-executor-e2e); the fork receipts below say what the REAL ledger needs.
const OV = (arg("--overheads", "29500,24000,7000")).split(",").map(Number);
if (OV.length !== 3 || OV.some((x) => !Number.isInteger(x) || x < 0 || x > 80_000)) { console.error("--overheads claim,renew,release (each 0..80000, MAX_OVERHEAD_GAS)"); process.exit(2); }
const LIMITS = { maxGasPriceCeiling: 10n ** 9n, overheadClaimGas: OV[0], overheadRenewGas: OV[1], overheadReleaseGas: OV[2], minClaimInterval: 60, l1Bps: L1_BPS };
const reserve = await deploy(A.reserve, [LEDGER, REGISTRY, ORACLE, LIMITS]);
const executor = await deploy(A.executor, [reserve]);
await send(DEPLOYER, { to: reserve, data: viem.encodeFunctionData({ abi: A.reserve.abi, functionName: "bindExecutor", args: [executor] }) });
const deployment = { chainId: 8453, reserve, executor, ledger: LEDGER, registry: REGISTRY,
  reserveCodeHash: viem.keccak256(await pc.getCode({ address: reserve })), executorCodeHash: viem.keccak256(await pc.getCode({ address: executor })) };
out.forkLocalDeployment = { ...deployment, limits: LIMITS, note: "deployed on the FORK only by anvil key #0; on Base nothing exists yet" };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fork-ten-app-"));
procs.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
const recBytes = Buffer.from(JSON.stringify({ format: "enclave-lease-gas-deployment/v1", ...deployment }));
const recFile = path.join(tmp, "lease-gas.json"); fs.writeFileSync(recFile, recBytes);
const recDigest = "sha256:" + crypto.createHash("sha256").update(recBytes).digest("hex");

// ---- 3. the ACTUAL CLI ----------------------------------------------------------------------------------------------
function cli(args, { expectFail = false } = {}) {
  return new Promise((ok, no) => {
    const p = spawn(process.execPath, [CLI, "--independent", "--contract-pins", PINS, "--rpc", proxies.join(","), "--confirmations", "0", "--max-block-age", "600",
      "--state-dir", path.join(tmp, "state"), "--json", ...args], { env: { PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: tmp, ENCLAVE_ADDRESS_BOOK: "" } });
    let so = "", se = "";
    p.stdout.on("data", (c) => (so += c)); p.stderr.on("data", (c) => (se += c));
    const t = setTimeout(() => p.kill("SIGKILL"), 300_000);
    p.on("close", (code) => { clearTimeout(t); if (expectFail ? code === 0 : code !== 0) return no(new Error(`cli exit ${code}: ${se}\n${so.slice(0, 2000)}`));
      let j = null; try { j = JSON.parse(so); } catch {} ok({ code, json: j, stderr: se }); });
  });
}
const lg = (...a) => ["lease-gas", ...a, "--lease-gas", recFile, "--lease-gas-digest", recDigest];
// PRE-WARM the fork: exactly the reads the CLI makes (the shared owner module, read-only, through a long-timeout client),
// so anvil has fetched the real ledger/registry state once before the CLI's quorum (12 s per request) reads it
{
  const O = await import("../network/lease-gas-owner.mjs");
  const one = { chainId: 8453, snapshot: async (fn) => { const blockNumber = await pc.getBlockNumber({ cacheTime: 0 });
    return { value: await fn(pc, blockNumber), blockNumber, agreeing: 1, peers: 1 }; } };
  const dep = { ...deployment };
  await O.verifyDeployment(one, dep);
  const factories = [{ address: PROFILE.contracts.sessionVaultFactory.address }, O.LEGACY_SESSION_VAULT_FACTORY];
  const warm = [...JSON.parse(fs.readFileSync(INVENTORY, "utf8")).selfHostedDeployments,
    { id: "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c" }];   // + the DNS deployment (4b)
  for (const d of warm) { const st = await O.appStatus(one, dep, d.id); await O.ownerKind(one, st.ledger.owner, { vaultFactories: factories }); }
  out.prewarmed = warm.length;
  if (warm.length !== 11) throw new Error("pre-warm list");
}
const refused = await cli(lg("plan", "--inventory", INVENTORY, "--max-gas-price-gwei", CAP_GWEI), { expectFail: true });
if (!/no default amount/.test(refused.stderr)) throw new Error("the plan did not refuse a missing amount: " + refused.stderr);
const planned = await cli(lg("plan", "--inventory", INVENTORY, "--max-gas-price-gwei", CAP_GWEI, ...AMOUNT));
const plan = planned.json;
const inv = JSON.parse(fs.readFileSync(INVENTORY, "utf8")).selfHostedDeployments;
if (plan.apps.length !== 10 || plan.apps.some((a, i) => a.id !== inv[i].id)) throw new Error("the plan does not cover exactly the ten inventory IDs, in order");
for (const a of plan.apps) {
  if (a.unknown || a.ownerKind.kind !== "eoa") throw new Error(`${a.id}: not an EOA-owned ledger row on the fork`);
  if (!a.steps.filter((s) => s.step !== "note").every((s) => s.simulated)) throw new Error(`${a.id}: a request did not simulate: ${JSON.stringify(a.steps.map((s) => s.simError))}`);
}
fs.mkdirSync(path.join(ROOT, "plans"), { recursive: true });
const planOut = { title: "lease-gas plan for the ten self-hosted inventory records - ACTUAL CLI output on a Base FORK (UNSIGNED; nothing sent to Base)",
  command: `enclave --independent --contract-pins contracts/deployments/contract-pins-base.json --rpc <fork A>,<fork B> lease-gas plan --inventory outputs/storage-adapter-incident/self-hosted-inventory.json --lease-gas <fork-local record> --lease-gas-digest ${recDigest} --max-gas-price-gwei ${CAP_GWEI} ${AMOUNT.join(" ")}`,
  ownerChoice: { amount: AMOUNT.join(" "), maxGasPriceGwei: CAP_GWEI, note: "chosen on this command line for the demonstration; the CLI has NO default and refused the same command without it" },
  refusedWithoutAmount: refused.stderr.trim().split("\n").pop(),
  reserveIsForkLocal: "the reserve/executor addresses below exist only on the fork: re-run against the real deployment's reviewed record (and fresh RPCs) right before signing",
  fork: out.fork, cli: plan };
fs.writeFileSync(path.join(ROOT, "plans/ten-app-cli-plan.json"), JSON.stringify(planOut, big, 1) + "\n");

// ---- 4. the owner executes exactly the printed requests (fork-local impersonation) ----------------------------------
const owner = viem.getAddress(plan.apps[0].owner);
const ownerEth = await pc.getBalance({ address: owner });
await rpc(anvilUrl, "anvil_impersonateAccount", [owner]);
const need = BigInt(plan.totalWei) + 10n ** 16n;
if (ownerEth < need) await rpc(anvilUrl, "anvil_setBalance", [owner, "0x" + need.toString(16)]);   // fork-local only: the real balance is reported below
for (const a of plan.apps) for (const s of a.steps) if (s.step !== "note") {
  const h = await rpc(anvilUrl, "eth_sendTransaction", [{ from: owner, to: s.to, data: s.data, value: "0x" + BigInt(s.value).toString(16) }]);
  const rc = await pc.waitForTransactionReceipt({ hash: h });
  if (rc.status !== "success") throw new Error(`${a.id} ${s.step} reverted on the fork`);
}
await rpc(anvilUrl, "anvil_stopImpersonatingAccount", [owner]);
const after = [];
for (const a of plan.apps) {
  const r = await pc.readContract({ address: reserve, abi: A.reserve.abi, functionName: "reserveOf", args: [a.id, owner] });
  const d = await pc.readContract({ address: LEDGER, abi: LEDGER_ABI, functionName: "get", args: [a.id] });
  if (!r.enabled || BigInt(r.balanceWei) !== BigInt(a.amount.wei)) throw new Error(`${a.id}: reserve not as planned`);
  if (d.rate !== 0n || lc(d.owner) !== lc(owner)) throw new Error(`${a.id}: the ledger row changed`);
  after.push({ id: a.id, reserveWei: r.balanceWei, enabled: r.enabled, claimPolicy: Number(r.claimPolicy), rate6: d.rate, runner: d.runner, leaseUntil: Number(d.leaseUntil) });
}
const status = await cli(lg("status", "--inventory", INVENTORY));
fs.writeFileSync(path.join(ROOT, "plans/ten-app-cli-status.json"), JSON.stringify({ title: "lease-gas status after executing the plan on the FORK (fork-local owner impersonation)",
  ownerRealEthAtFork: ownerEth, ownerTopUpOnForkOnly: ownerEth < need, reservesAfter: after, cli: status.json }, big, 1) + "\n");
function lc(x) { return String(x).toLowerCase(); }

// ---- 4b. the funded, NOT self-hosted DNS deployment (root 16:22Z: the phone host cannot reattach without it) ---------------
// Its owner is not the host's payout wallet, so "self-hosted" cannot match: the plan uses an explicit allowlist with its
// last operator (the owner may name others, or "any"). Its USDC compute balance is untouched. An unsigned plan for that
// owner to review: no consent is assumed, nothing here is sent to Base.
const DNS_ID = "0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c";
const DNS_OPERATOR = "0x1A01194c34Fe3577C6d0a54feB78af6253e494e0";
const dnsPlan = (await cli(lg("plan", "--ids", DNS_ID, "--max-gas-price-gwei", CAP_GWEI, "--claim-policy", "allowlist", ...AMOUNT))).json;
const dnsClaimant = (await cli(lg("claimant", DNS_ID, DNS_OPERATOR, "--allow"))).json;
const dnsApp = dnsPlan.apps[0];
if (dnsApp.unknown || !dnsApp.steps.filter((x) => x.step !== "note").every((x) => x.simulated)) throw new Error("the DNS plan did not simulate");
const dnsRow = await pc.readContract({ address: LEDGER, abi: LEDGER_ABI, functionName: "get", args: [DNS_ID] });
// execute on the FORK exactly as printed: each request from ITS sender (an EOA owner, or a SessionVault's owner wallet
// calling ownerCall), by fork-local impersonation; then check the reserve (keyed to the owner of record) and the claimant
const dnsOwner = viem.getAddress(dnsApp.owner);
const dnsSends = [...dnsApp.steps.filter((x) => x.step !== "note"),
  dnsClaimant.unsigned ? { from: dnsClaimant.unsigned.from, to: dnsClaimant.unsigned.to, data: dnsClaimant.unsigned.data, value: dnsClaimant.unsigned.value } : null].filter(Boolean);
if (dnsSends.some((x) => !x.from)) throw new Error("a DNS request names no sender (a Safe owner?): execute it by that path");
const dnsSenderEth = {};
for (const x of dnsSends) {
  const from = viem.getAddress(x.from);
  if (!(from in dnsSenderEth)) {
    dnsSenderEth[from] = await pc.getBalance({ address: from });
    await rpc(anvilUrl, "anvil_impersonateAccount", [from]);
    if (dnsSenderEth[from] < BigInt(dnsPlan.totalWei) + 10n ** 16n) await rpc(anvilUrl, "anvil_setBalance", [from, "0x" + (BigInt(dnsPlan.totalWei) + 10n ** 16n).toString(16)]);
  }
  const h = await rpc(anvilUrl, "eth_sendTransaction", [{ from, to: x.to, data: x.data, value: "0x" + BigInt(x.value).toString(16) }]);
  if ((await pc.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error("a DNS request reverted on the fork");
}
for (const from of Object.keys(dnsSenderEth)) await rpc(anvilUrl, "anvil_stopImpersonatingAccount", [from]);
const dnsOwnerEth = dnsSenderEth;
const dnsReserve = await pc.readContract({ address: reserve, abi: A.reserve.abi, functionName: "reserveOf", args: [DNS_ID, dnsOwner] });
const dnsAllowed = await pc.readContract({ address: reserve, abi: [{ type: "function", name: "claimantAllowed", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "address" }], outputs: [{ type: "bool" }] }],
  functionName: "claimantAllowed", args: [viem.keccak256(viem.encodeAbiParameters([{ type: "bytes32" }, { type: "address" }], [DNS_ID, dnsOwner])), DNS_OPERATOR] });
if (!dnsReserve.enabled || Number(dnsReserve.claimPolicy) !== 2 || !dnsAllowed) throw new Error("the DNS enrollment did not take on the fork");
fs.writeFileSync(path.join(ROOT, "plans/dns-deployment-cli-plan.json"), JSON.stringify({
  title: "lease-gas plan for the funded, NOT self-hosted DNS deployment - ACTUAL CLI output on a Base FORK (UNSIGNED; nothing sent to Base; no consent assumed)",
  id: DNS_ID, why: "root 16:22Z: its lease expired on 0x1A01…94e0; the phone host's EnclaveDNS upstream depends on it",
  ledgerAtFork: { owner: dnsRow.owner, rate6: dnsRow.rate, balance6: dnsRow.balance6, runnerOperator: dnsRow.runnerOperator, leaseUntil: Number(dnsRow.leaseUntil),
    note: "the USDC compute balance stays where it is; lease gas is a separate ETH reserve" },
  ownerChoice: { amount: AMOUNT.join(" "), maxGasPriceGwei: CAP_GWEI, claimPolicy: "allowlist", claimant: DNS_OPERATOR,
    note: "the owner may allow other operators instead (or claim policy any); nothing here is the owner's decision" },
  sendersEthOnForkAfterTheTenAppTopUp: dnsOwnerEth, ownerKind: dnsApp.ownerKind, plan: dnsPlan, claimant: dnsClaimant,
  executedOnForkOnly: { reserveWei: dnsReserve.balanceWei, enabled: dnsReserve.enabled, claimPolicy: Number(dnsReserve.claimPolicy), claimantAllowed: dnsAllowed } }, big, 1) + "\n");

// ---- 5. calibration with a fork-local fixture host on the REAL ledger and registry -----------------------------------
const opKey = generatePrivateKey(), op = privateKeyToAccount(opKey);
const relayKey = generatePrivateKey(), relayAcct = privateKeyToAccount(relayKey);
await rpc(anvilUrl, "anvil_setBalance", [op.address, "0x16345785d8a0000"]);
await rpc(anvilUrl, "anvil_setBalance", [relayAcct.address, "0x16345785d8a0000"]);
const endpoint = `https://fork-calibration-${crypto.randomBytes(4).toString("hex")}.invalid`;
const enclaveId = viem.keccak256(viem.toBytes(endpoint));
const REG_ABI = viem.parseAbi(["function register(string,string,bytes32,uint64,uint64,address) returns (bytes32)", "function setPayoutWallet(bytes32)"]);
await send(opKey, { to: REGISTRY, data: viem.encodeFunctionData({ abi: REG_ABI, functionName: "register", args: [endpoint, "fork/calibration", viem.zeroHash, 1000n, 0n, op.address] }) });
await rpc(anvilUrl, "anvil_setBalance", [op.address, "0x0"]);
await rpc(anvilUrl, "anvil_impersonateAccount", [owner]);
await pc.waitForTransactionReceipt({ hash: await rpc(anvilUrl, "eth_sendTransaction", [{ from: owner, to: REGISTRY, data: viem.encodeFunctionData({ abi: REG_ABI, functionName: "setPayoutWallet", args: [enclaveId] }) }]) });
await rpc(anvilUrl, "anvil_stopImpersonatingAccount", [owner]);
const clock = { offset: 0 };   // the fork clock is moved into the renew window below: relay and host judge freshness by it
const relay = await B.startLeaseRelay({ client: pc, wallet: wc(relayKey), deployment, allowLoopbackHttp: true, log: () => {}, now: () => Date.now() + clock.offset });
procs.push(() => relay.close());
const host = B.createLeaseClient({ client: pc, clients: [pc], account: op, reserve, deployment, relays: [relay.url], allowLoopbackHttp: true, confirmations: 0,
  requestTimeoutMs: 20_000, now: () => Date.now() + clock.offset, log: () => {} });
const expired = inv.filter((d) => !d.liveLease);
const [target, target2] = expired;   // two EXPIRED inventory records: a first claim (with the authorization), then an ordinary one
const rowOf = (id) => pc.readContract({ address: LEDGER, abi: LEDGER_ABI, functionName: "get", args: [id] });
const row = () => rowOf(target.id);
for (const t of [target, target2]) if ((await rowOf(t.id)).leaseUntil >= (await pc.getBlock()).timestamp) throw new Error(`${t.id} is leased on the fork`);
const PAID = A.reserve.abi.filter((x) => x.name === "LeaseGasPaid");
const l1Abi = viem.parseAbi(["function getL1Fee(bytes) view returns (uint256)", "function getL1FeeUpperBound(uint256) view returns (uint256)"]);
/** The UNSIGNED fully RLP-encoded transaction GasPriceOracle.getL1Fee expects (it adds 68 bytes for the outer signature
 *  itself): the outer signature stripped, EIP-7702 authorization tuples KEPT with their own signatures. Checked: adding
 *  the outer signature back reproduces the transaction hash. */
function encodings(tx) {
  const base = { chainId: Number(tx.chainId), nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    to: tx.to, value: tx.value, data: tx.input, accessList: tx.accessList ?? [] };
  const t = tx.type === "eip7702"
    ? { ...base, type: "eip7702", authorizationList: tx.authorizationList.map((a) => ({ address: a.address ?? a.contractAddress, chainId: Number(a.chainId), nonce: Number(a.nonce), r: a.r, s: a.s, yParity: a.yParity })) }
    : { ...base, type: "eip1559" };
  const unsigned = viem.serializeTransaction(t), signed = viem.serializeTransaction(t, { r: tx.r, s: tx.s, yParity: tx.yParity });
  if (viem.keccak256(signed) !== tx.hash) throw new Error(`${tx.hash}: re-encoding does not reproduce the transaction`);
  return { unsigned, signed };
}
const { UNSIGNED_ENVELOPE_BYTES, AUTHORIZATION_BYTES } = { UNSIGNED_ENVELOPE_BYTES: 72, AUTHORIZATION_BYTES: 105 };   // the reserve's constants
async function measure(kind, r) {
  const rc = r.receipt, tx = await pc.getTransaction({ hash: r.hash });
  const blk = await pc.getBlock({ blockNumber: rc.blockNumber });
  if (blk.baseFeePerGas !== forkBaseFee) throw new Error(`block ${rc.blockNumber} base fee ${blk.baseFeePerGas} is not the fork block's ${forkBaseFee}`);
  const { unsigned, signed } = encodings(tx);
  const ev = viem.parseEventLogs({ abi: PAID, logs: rc.logs })[0].args;
  const l1Estimate = await pc.readContract({ address: ORACLE, abi: l1Abi, functionName: "getL1Fee", args: [unsigned], blockNumber: rc.blockNumber });
  const auth = tx.authorizationList?.length || 0;
  const sizedFor = BigInt(388 + UNSIGNED_ENVELOPE_BYTES + (auth ? AUTHORIZATION_BYTES : 0));
  const l2Cost = rc.gasUsed * rc.effectiveGasPrice;
  return { kind, hash: r.hash, block: Number(rc.blockNumber), blockBaseFee: blk.baseFeePerGas, type: tx.type, authorizations: auth,
    receiptGasUsed: rc.gasUsed, effectiveGasPrice: rc.effectiveGasPrice, chargedGas: ev.gas, chargedGasPrice: ev.gasPrice, gasMargin: ev.gas - rc.gasUsed,
    signedBytes: (signed.length - 2) / 2, unsignedBytes: (unsigned.length - 2) / 2, reserveSizedUnsignedBytes: Number(sizedFor),
    l1ChargedWei: ev.l1FeeWei, oracleL1EstimateWei: l1Estimate, chargedWei: ev.chargedWei,
    relayL2CostWei: l2Cost, relayCostWithL1EstimateWei: l2Cost + l1Estimate, marginWei: ev.chargedWei - (l2Cost + l1Estimate) };
}
const cal = [];
const before = (await pc.readContract({ address: reserve, abi: A.reserve.abi, functionName: "reserveOf", args: [target.id, owner] })).balanceWei;
cal.push(await measure("claim, first lease of the key (carries its EIP-7702 authorization)", await host.claim(target.id, enclaveId)));
const charged1 = await pc.readContract({ address: op.address, abi: [{ type: "function", name: "authorizationCharged", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] }], functionName: "authorizationCharged" });
if (!charged1) throw new Error("the executor did not record the key's first lease");
cal.push(await measure("claim, key already delegated (no authorization)", await host.claim(target2.id, enclaveId)));
const claimed = await row();
if (lc(claimed.runnerOperator) !== lc(op.address) || claimed.rate !== 0n) throw new Error("claim did not take on the real ledger at rate 0");
// into the owner's renew window: move the fork clock to 200 s before the end
await mineOne(Number(claimed.leaseUntil) - 200);
clock.offset = (Number(claimed.leaseUntil) - 200) * 1000 - Date.now();
cal.push(await measure("renew", await host.renew(target.id)));
cal.push(await measure("release", await host.release(target.id)));
cal.push(await measure("release (second record)", await host.release(target2.id)));
const afterCal = (await pc.readContract({ address: reserve, abi: A.reserve.abi, functionName: "reserveOf", args: [target.id, owner] })).balanceWei;
const oracleVersion = await pc.readContract({ address: ORACLE, abi: viem.parseAbi(["function version() view returns (string)"]), functionName: "version" }).catch(() => null);
const calibration = { title: "Design B on a Base FORK: the REAL ledger rev 16d and registry schema 4 bytecode/state, Base's GasPriceOracle at the fork block",
  fork: out.fork, deployment: out.forkLocalDeployment, records: [target.id, target2.id],
  fixtureHost: { operator: op.address, enclaveId, operatorEthWei: await pc.getBalance({ address: op.address }) },
  receipts: cal, minMarginWei: cal.reduce((m, c) => (c.marginWei < m ? c.marginWei : m), cal[0].marginWei), reserveSpentOnFirstRecordWei: before - afterCal,
  l1Bps: L1_BPS, oracleVersionAtFork: oracleVersion,
  l1Sizing: "the reserve asks getL1FeeUpperBound for the UNSIGNED size: 388 calldata + 72 envelope (+105 for an authorization); the oracle adds 68 for the signature",
  real: ["ledger/registry runtime bytecode and storage at the fork block (code hashes = the reviewed profile)", "the ten inventory rows (ids, owner, rate 0, leases) at the fork block",
    "the GasPriceOracle code and its L1 parameters (L1Block state) at the fork block: getL1Fee/getL1FeeUpperBound values",
    "every calibration block mined at the fork block's REAL base fee (asserted per receipt)", "the live Base eth_maxPriorityFeePerGas read at fork time (served to the CLI)",
    "EVM gas of every lease operation, including the EIP-7702 authorization (Prague rules in anvil)"],
  notReproducedOnAnvil: ["the L1 fee is NOT debited by anvil: oracleL1EstimateWei is the forked GasPriceOracle's getL1Fee of the exact UNSIGNED bytes - an ESTIMATE, not a fee actually paid on Base",
    "Base's own execution rules beyond the EVM (anvil is not Base's node: no OP/Jovian fee rules, no operator fee) - root's live read: oracle 1.6.0, isJovian, getOperatorFee(300000) = 0 at block 52,863,833 (work/app-lease-gas-root-oracle-live.json)",
    "base-fee evolution after the fork block, priority-fee competition, sequencer ordering and mempool behaviour", "public-relay operations (availability, rate limits, a relay's own key management)",
    "time: the renew used a moved fork clock (evm_setNextBlockTimestamp); oracle state does not advance with it"],
  notFabricated: "no fee value in this file is invented: each is a receipt field, an event field, or an eth_call on the forked oracle" };
const calOut = arg("--calibration-out", "fixtures/base-fork-calibration.json");
fs.writeFileSync(path.join(ROOT, calOut), JSON.stringify(calibration, big, 1) + "\n");
console.log(JSON.stringify({ forkBlock: out.fork.block, apps: plan.apps.length, totalWei: plan.totalWei, perApp: plan.apps[0].amount,
  calibration: cal.map((c) => ({ kind: c.kind, gas: c.receiptGasUsed, charged: c.chargedWei, relayCost: c.relayCostWithL1EstimateWei, margin: c.marginWei })) }, big, 1));
cleanup();
process.exit(0);
