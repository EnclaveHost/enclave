// Round 3: the app OWNER's CLI path, end to end through the REAL main CLI entry with the lease-gas dispatch hunk applied
// (shadow-cli/cli/enclave.mjs = main cli/enclave.mjs + patches/lease-gas-cli-dispatch.hunk.patch; every other module is
// main's own file). Independent mode: two RPC origins (anvil + a pass-through proxy on another port) must agree.
// The CLI never signs: the TEST plays the owner's wallet (MetaMask) with fixture keys and sends exactly what it printed.
// Owners: a plain EOA, an EIP-7702-delegated EOA, the ORIGINAL SessionVault (forge/src/legacy, verbatim source) through
// ownerCall, a Safe (the canonical Safe v1.4.1 runtime read from Base, fixtures/safe-code-base.json), a previous owner
// after a transfer, and an unknown contract (refused).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey, sign } from "viem/accounts";
import { startWorld, haveAnvil, art, DEPLOYER, LIMITS } from "./helpers/b-world.mjs";
import * as O from "../network/lease-gas-owner.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "shadow-cli/cli/enclave.mjs");
const SAFE = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/safe-code-base.json"), "utf8")); } catch { return null; } })();
const T = { skip: !haveAnvil && "needs anvil", timeout: 300_000 };
let W, proxy, tmp, pinsFile, recFile, recDigest, base;

before(async () => {
  if (!haveAnvil) return;
  W = await startWorld();
  // Anvil suggests a 1 gwei priority fee. A higher TEST reserve ceiling allows both the covered-cap and underpriced-cap
  // paths to run without altering real RPC fee responses or weakening the CLI's warning.
  Object.assign(W.addr, await W.newReserve({ ...LIMITS, maxGasPriceCeiling: 2_000_000_000n }));
  // a second RPC origin: a plain pass-through to the same anvil (the quorum needs two distinct origins)
  proxy = http.createServer((req, res) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", async () => {
    const r = await fetch(W.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: b });
    res.writeHead(r.status, { "content-type": "application/json" }); res.end(await r.text()); }); });
  await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lease-gas-cli-"));
  // the original SessionVault factory (legacy source), pinned as the session factory of these contract pins
  const book = await W.deploy(art("LeaseExecutor.t.sol", "MockBook"));
  await W.write(DEPLOYER, book, art("LeaseExecutor.t.sol", "MockBook").abi, "set", [viem.stringToHex("deployments", { size: 32 }), W.addr.ledger]);
  const F = art("SessionVault.sol", "SessionVaultFactory");
  W.addr.vaultFactory = await W.deploy(F, [W.addr.usdc, book, "0x000000000000000000000000000000000000bEEF", viem.zeroAddress, 250_000_000n],
    { "src/legacy/SessionVault.sol:SessionVaultLib": await W.deploy(art("SessionVault.sol", "SessionVaultLib")) });
  pinsFile = path.join(tmp, "pins.json");
  fs.writeFileSync(pinsFile, JSON.stringify({ version: 1, chainId: 8453, contracts: { registry: W.addr.registry, deployments: W.addr.ledger,
    appCatalog: "0x00000000000000000000000000000000000000c1", proofOfTime: "0x00000000000000000000000000000000000000c2",
    enclavePay: viem.zeroAddress, verificationFees: viem.zeroAddress, sessionVaultFactory: W.addr.vaultFactory, secretVaultV2: viem.zeroAddress } }));
  recFile = path.join(tmp, "lease-gas.json");
  const rec = Buffer.from(JSON.stringify({ format: O.DEPLOYMENT_FORMAT, chainId: 8453, reserve: W.addr.reserve, executor: W.addr.executor,
    reserveCodeHash: W.addr.reserveCodeHash, executorCodeHash: W.addr.executorCodeHash, ledger: W.addr.ledger, registry: W.addr.registry }));
  fs.writeFileSync(recFile, rec);
  recDigest = "sha256:" + crypto.createHash("sha256").update(rec).digest("hex");
  base = ["--independent", "--contract-pins", pinsFile, "--rpc", `${W.rpcUrl},http://127.0.0.1:${proxy.address().port}`, "--confirmations", "0",
    "--max-block-age", "86400", "--state-dir", path.join(tmp, "state")];
});
after(() => { proxy?.close(); W?.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

/** Run the main CLI entry (shadow tree) and parse its --json output. */
function cli(args, { json = true, expectFail = false } = {}) {
  return new Promise((ok, no) => {
    const p = spawn(process.execPath, [CLI, ...base, ...(json ? ["--json"] : []), ...args], { env: { PATH: process.env.PATH, HOME: tmp, XDG_CONFIG_HOME: tmp, ENCLAVE_ADDRESS_BOOK: "" } });
    let out = "", err = "";
    p.stdout.on("data", (c) => (out += c)); p.stderr.on("data", (c) => (err += c));
    const t = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("close", (code) => {
      clearTimeout(t);
      if (expectFail ? code === 0 : code !== 0) return no(new Error(`cli ${args.slice(0, 3).join(" ")} exit ${code}\n${err}\n${out}`));
      let j = null; try { j = JSON.parse(out); } catch {}
      ok({ code, out, err, json: j });
    });
  });
}
const lg = (sub, ...rest) => ["lease-gas", sub, ...rest, "--lease-gas", recFile, "--lease-gas-digest", recDigest];
/** The owner's wallet sends exactly the printed request (what MetaMask would do with these params). */
async function walletSends(key, u) {
  assert.ok(u.from === null || u.from === undefined || u.from.toLowerCase() === privateKeyToAccount(key).address.toLowerCase(), "the printed sender is this wallet");
  return W.send(key, { to: u.to, data: u.data, value: BigInt(u.value) });
}
const R = (id, who) => W.reserveOf(id, who);

test("EOA owner: status (unconfigured, actionable), deposit, configure, then status shows balances/caps/fee/L1/proof/bond", T, async () => {
  const o = await W.owner(); const id = await W.create(o);
  // the ledger demands a claim bond (USDC collateral) in this world: status must say so, and that the reserve does not pay it
  await W.write(DEPLOYER, W.addr.ledger, W.A.ledger.abi, "setClaimBond", [100_000_000n, 86400n]);
  let s = (await cli(lg("status", id))).json;
  const a = s.apps[0];
  assert.equal(a.reserve.configured, false); assert.equal(a.ownerKind.kind, "eoa");
  assert.ok(a.advice.some((x) => /not configured/.test(x.text)) && a.advice.some((x) => /reserve is empty/.test(x.text)));
  assert.match(a.gates.claimBondNote, /100 USDC claim bond.*USDC collateral, not gas/);
  assert.ok(BigInt(s.fee.effective) > 0n && s.limits && a.l1 && a.cost.formula.includes("388"));
  // no amount -> refused; an amount -> the exact unsigned deposit, simulated from the owner
  await cli(lg("deposit", id), { expectFail: true });
  const d = (await cli([...lg("deposit", id, "--eth", "0.02"), "--from", o.address])).json;
  assert.equal(d.via, "direct"); assert.equal(d.unsigned.to, W.addr.reserve); assert.equal(BigInt(d.unsigned.value), 2n * 10n ** 16n); assert.equal(d.simulated.simulated, true);
  await walletSends(o.key, d.unsigned);
  assert.equal((await R(id, o.address)).balanceWei, 2n * 10n ** 16n);
  // configure: the gas price cap is the owner's choice (no silent default); MetaMask format; caps derived and stated
  const e = await cli(lg("configure", id), { expectFail: true });
  assert.match(e.err + e.out, /--max-gas-price-gwei/);
  const c = (await cli([...lg("configure", id, "--max-gas-price-gwei", "1.5", "--claim-policy", "self-hosted", "--format", "metamask")])).json;
  assert.equal(c.unsigned.chainId, "0x2105"); assert.equal(c.unsigned.value, "0x0"); assert.ok(c.notes.some((n) => /renew charges/.test(n)));
  await walletSends(o.key, c.unsigned);
  s = (await cli(lg("status", id))).json.apps[0];
  assert.equal(s.reserve.enabled, true); assert.equal(s.reserve.claimPolicy, "self-hosted"); assert.equal(BigInt(s.reserve.maxGasPrice), 1_500_000_000n);
  assert.ok(BigInt(s.reserve.maxPerOpWei) >= BigInt(s.cost.atOwnerCap.claim), "the derived per-op cap covers a claim at the owner's own price cap");
  assert.ok(!s.advice.some((x) => x.level === "action"), JSON.stringify(s.advice));
  // the bound is honest: a cap below the market fee is reported as an action, not "Ready"
  const low = (await cli(lg("configure", id, "--max-gas-price-gwei", "0.000000001"))).json;
  await walletSends(o.key, low.unsigned);
  s = (await cli(lg("status", id))).json.apps[0];
  assert.ok(s.advice.some((x) => /above the owner's cap/.test(x.text)));
  await W.write(DEPLOYER, W.addr.ledger, W.A.ledger.abi, "setClaimBond", [0n, 86400n]);
});

test("EOA owner through the EXISTING signer handoff: the intent is journaled, MetaMask sends it, `signer attach` confirms it", T, async () => {
  const o = await W.owner(); const id = await W.create(o);
  const h = (await cli([...lg("deposit", id, "--eth", "0.01"), "--signer-mode", "handoff", "--from", o.address])).json;
  assert.ok(h.handoff && h.transaction, JSON.stringify(h));
  const journal = fs.readdirSync(path.join(tmp, "state", "signer"));
  assert.ok(journal.some((f) => f.includes(h.handoff)), "the intent is in the existing signer journal before anything is sent");
  const t = h.transaction;
  const hash = await W.wc(o.key).sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value), gas: BigInt(t.gas), nonce: Number(BigInt(t.nonce)),
    maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) });
  await W.pc.waitForTransactionReceipt({ hash });
  const at = await cli(["signer", "attach", h.handoff, hash, "--signer-mode", "handoff", "--from", o.address]);
  assert.match(at.out, /confirmed|success/i);
  assert.equal((await R(id, o.address)).balanceWei, 10n ** 16n);
  // a request for another wallet is refused before any journal entry
  const other = await W.owner();
  const bad = await cli([...lg("configure", id, "--max-gas-price-gwei", "0.05"), "--signer-mode", "handoff", "--from", other.address], { expectFail: true });
  assert.match(bad.err, /owner of record is .* cannot act for it/);
});

test("EIP-7702-delegated EOA owner is still an EOA sender; an unknown contract owner is refused", T, async () => {
  const o = await W.owner(); const id = await W.create(o);
  await W.rpc("anvil_setCode", [o.address, "0xef0100" + W.addr.executor.slice(2).toLowerCase()]);
  const c = (await cli(lg("configure", id, "--max-gas-price-gwei", "0.05"))).json;
  assert.equal(c.via, "direct"); assert.ok(c.notes.some((n) => /EIP-7702-delegated/.test(n)));
  await W.rpc("anvil_setCode", [o.address, "0x"]);
  // Live rev16d refuses transfers with refundable compute escrow. An unfunded record can transfer immediately.
  const o2 = await W.owner(); const id2 = await W.create(o2, { fund6: 0n });
  await W.write(o2.key, W.addr.ledger, W.A.ledger.abi, "transferDeployment", [id2, W.addr.usdc]);   // a contract that is no wallet
  const r = await cli(lg("configure", id2, "--max-gas-price-gwei", "0.05"), { expectFail: true });
  assert.match(r.err, /neither an EOA, a SessionVault of a pinned factory nor a Safe/);
});

test("ORIGINAL SessionVault owner: configure and withdraw are vault.ownerCall from the vault owner; withdrawal goes to the owner's wallet", T, async () => {
  const vo = await W.owner();
  const F = art("SessionVault.sol", "SessionVaultFactory"), V = art("SessionVault.sol", "SessionVault");
  await W.write(vo.key, W.addr.vaultFactory, F.abi, "createVault", [vo.address]);
  const vault = await W.pc.readContract({ address: W.addr.vaultFactory, abi: F.abi, functionName: "vaultFor", args: [vo.address] });
  const createData = viem.encodeFunctionData({ abi: W.A.ledger.abi, functionName: "create", args: ["catalog://app/0", 0, 500, 8080, "", true, "", viem.zeroAddress, 0n, 1000n] });
  const { result } = await W.pc.simulateContract({ account: vo.address, address: vault, abi: V.abi, functionName: "ownerCall", args: [W.addr.ledger, createData] });
  await W.write(vo.key, vault, V.abi, "ownerCall", [W.addr.ledger, createData]);
  const id = viem.decodeAbiParameters([{ type: "bytes32" }], result)[0];
  // deposit: any wallet (the vault owner's), credited to the VAULT's reserve
  const d = (await cli(lg("deposit", id, "--eth", "0.01"))).json;
  assert.equal(d.unsigned.from.toLowerCase(), vo.address.toLowerCase());
  await walletSends(vo.key, d.unsigned);
  assert.equal((await R(id, vault)).balanceWei, 10n ** 16n);
  // configure: ownerCall(reserve, configure(...)) to the vault, from its owner
  const c = (await cli(lg("configure", id, "--max-gas-price-gwei", "0.05"))).json;
  assert.equal(c.via, "ownerCall"); assert.equal(c.unsigned.to.toLowerCase(), vault.toLowerCase()); assert.equal(c.inner.to, W.addr.reserve);
  assert.equal(viem.decodeFunctionData({ abi: V.abi, data: c.unsigned.data }).functionName, "ownerCall");
  await walletSends(vo.key, c.unsigned);
  assert.equal((await R(id, vault)).enabled, true);
  // a different --from cannot act for the vault
  const other = await W.owner();
  assert.match((await cli([...lg("configure", id, "--max-gas-price-gwei", "0.05"), "--from", other.address], { expectFail: true })).err, /only that wallet can call its ownerCall/);
  // withdraw all: to the vault OWNER (the vault has no receive()); --to the vault itself is refused before anything is prepared
  assert.match((await cli(lg("withdraw", id, "--all", "--to", vault), { expectFail: true })).err, /cannot receive ETH/);
  const w = (await cli(lg("withdraw", id, "--all"))).json;
  const inner = viem.decodeFunctionData({ abi: O.OWNER_ABI, data: w.inner.data });
  assert.equal(inner.functionName, "withdraw"); assert.equal(inner.args[2].toLowerCase(), vo.address.toLowerCase());
  const b0 = await W.pc.getBalance({ address: vo.address });
  const rc = await walletSends(vo.key, w.unsigned);
  const b1 = await W.pc.getBalance({ address: vo.address });
  assert.equal(b1 - b0 + rc.gasUsed * rc.effectiveGasPrice, 10n ** 16n);
  assert.equal((await R(id, vault)).balanceWei, 0n);
});

test("Safe owner (canonical Safe v1.4.1 code): a Safe transaction, executed by the Safe's own signer", { ...T, skip: T.skip || (!SAFE && "fixtures/safe-code-base.json missing (scripts/snapshot-safe-code.mjs)") }, async () => {
  for (const c of Object.values(SAFE.contracts)) await W.rpc("anvil_setCode", [c.address, c.code]);
  const SAFE_ABI = viem.parseAbi(["function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address paymentReceiver)",
    "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
    "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)",
    "function nonce() view returns (uint256)"]);
  const FACT = viem.parseAbi(["function createProxyWithNonce(address _singleton,bytes initializer,uint256 saltNonce) returns (address proxy)"]);
  const signerKey = generatePrivateKey(), signer = privateKeyToAccount(signerKey);
  await W.fund(signer.address);
  const init = viem.encodeFunctionData({ abi: SAFE_ABI, functionName: "setup", args: [[signer.address], 1n, viem.zeroAddress, "0x", viem.zeroAddress, viem.zeroAddress, 0n, viem.zeroAddress] });
  const { result: safe } = await W.pc.simulateContract({ account: signer.address, address: SAFE.contracts.safeProxyFactory.address, abi: FACT, functionName: "createProxyWithNonce", args: [SAFE.contracts.safeL2.address, init, 7n] });
  await W.write(signerKey, SAFE.contracts.safeProxyFactory.address, FACT, "createProxyWithNonce", [SAFE.contracts.safeL2.address, init, 7n]);
  const exec = async (to, data, value = 0n) => {
    const nonce = await W.pc.readContract({ address: safe, abi: SAFE_ABI, functionName: "nonce" });
    const h = await W.pc.readContract({ address: safe, abi: SAFE_ABI, functionName: "getTransactionHash", args: [to, value, data, 0, 0n, 0n, 0n, viem.zeroAddress, viem.zeroAddress, nonce] });
    const sig = viem.serializeSignature(await sign({ hash: h, privateKey: signerKey }));
    return W.write(signerKey, safe, SAFE_ABI, "execTransaction", [to, value, data, 0, 0n, 0n, 0n, viem.zeroAddress, viem.zeroAddress, sig]);
  };
  // the Safe creates a deployment (it is the owner of record)
  const createData = viem.encodeFunctionData({ abi: W.A.ledger.abi, functionName: "create", args: ["catalog://app/0", 0, 500, 8080, "", true, "", viem.zeroAddress, 0n, 1000n] });
  const rc = await exec(W.addr.ledger, createData);
  const id = rc.logs.map((l) => { try { return viem.decodeEventLog({ abi: W.A.ledger.abi, ...l }); } catch { return null; } }).find((e) => e?.args?.id)?.args.id;
  assert.ok(id, "deployment id from the ledger's event");
  const s = (await cli(lg("status", id))).json.apps[0];
  assert.equal(s.ownerKind.kind, "safe"); assert.equal(s.ownerKind.detail, "1 of 1");
  // configure -> Safe Transaction Builder JSON (never a direct transaction, never this CLI's signer)
  const c = (await cli(lg("configure", id, "--max-gas-price-gwei", "0.05"))).json;
  assert.equal(c.via, "safe"); assert.equal(c.safe.safe.toLowerCase(), safe.toLowerCase());
  const t = c.safeTransactionBuilder.transactions[0];
  assert.equal(t.to, W.addr.reserve); assert.equal(c.safeTransactionBuilder.chainId, "8453");
  await exec(t.to, t.data, BigInt(t.value));
  assert.equal((await R(id, safe)).enabled, true);
  // a deposit from a named payer is a plain transaction (anyone may pay); without --from it is a Safe transaction
  const d = (await cli([...lg("deposit", id, "--eth", "0.003"), "--from", signer.address])).json;
  assert.equal(d.via, "direct");
  await walletSends(signerKey, d.unsigned);
  assert.equal((await R(id, safe)).balanceWei, 3n * 10n ** 15n);
  // withdraw: a Safe transaction paying the Safe itself (a Safe receives ETH)
  const w = (await cli(lg("withdraw", id, "--wei", "1000"))).json;
  assert.equal(w.via, "safe");
  const tw = w.safeTransactionBuilder.transactions[0];
  await exec(tw.to, tw.data, 0n);
  assert.equal((await R(id, safe)).balanceWei, 3n * 10n ** 15n - 1000n);
});

test("previous owner after a transfer withdraws ITS reserve (--as); the new owner's reserve is separate", T, async () => {
  // The app gas reserve is independent of compute escrow, which must be empty/refunded before a live-ledger transfer.
  const a = await W.owner(), b = await W.owner(); const id = await W.create(a, { fund6: 0n });
  await walletSends(a.key, (await cli(lg("deposit", id, "--eth", "0.004"))).json.unsigned);
  await W.write(a.key, W.addr.ledger, W.A.ledger.abi, "transferDeployment", [id, b.address]);
  const s = (await cli(lg("status", id))).json.apps[0];
  assert.equal(s.ledger.owner, b.address); assert.equal(BigInt(s.reserve.balanceWei), 0n);
  const w = (await cli(lg("withdraw", id, "--all", "--as", a.address))).json;
  assert.equal(w.unsigned.from, a.address);
  await walletSends(a.key, w.unsigned);
  assert.equal((await R(id, a.address)).balanceWei, 0n);
});

test("plan for many apps: no default amount; --per-app-eth / --per-app-wei / --days; every request simulated; senders' balances", T, async () => {
  const o = await W.owner(); const ids = [await W.create(o), await W.create(o), await W.create(o)];
  const bad = await cli(lg("plan", "--ids", ids.join(","), "--max-gas-price-gwei", "0.05"), { expectFail: true });
  assert.match(bad.err, /no default amount/);
  const p = (await cli(lg("plan", "--ids", ids.join(","), "--max-gas-price-gwei", "0.05", "--per-app-eth", "0.002"))).json;
  assert.equal(p.apps.length, 3);
  for (const a of p.apps) {
    assert.equal(a.amount.eth, "0.002");
    assert.deepEqual(a.steps.map((s) => s.step), ["deposit", "configure"]);
    assert.ok(a.steps.every((s) => s.simulated), JSON.stringify(a.steps.map((s) => s.simError)));
  }
  assert.equal(BigInt(p.totalWei), 6n * 10n ** 15n);
  assert.equal(p.senders.length, 1); assert.equal(p.senders[0].enough, true);
  const pw = (await cli(lg("plan", "--ids", ids[0], "--max-gas-price-gwei", "0.05", "--per-app-wei", "12345"))).json;
  assert.equal(pw.apps[0].amount.wei, "12345");
  const pd = (await cli(lg("plan", "--ids", ids[0], "--max-gas-price-gwei", "0.05", "--days", "7"))).json;
  // the deployed ledger extends a renew FROM leaseUntil: covering 7 days takes ceil(604800 / leaseSec) - 1 renewals
  const m = /one claim \+ (\d+) renewals \(7 days of a rate-0 \/ fully funded lease, leaseSec (\d+)\)/.exec(pd.apps[0].amount.basis);
  assert.ok(m, pd.apps[0].amount.basis);
  const leaseSec = BigInt(m[2]), n = BigInt(m[1]);
  assert.equal(n, (604800n + leaseSec - 1n) / leaseSec - 1n);
  const per = pd.costModel.perOp;
  assert.equal(BigInt(pd.apps[0].amount.wei), BigInt(per.claim) + n * BigInt(per.renew) + BigInt(per.release), "integer wei: claim + n renewals + release");
  assert.ok(BigInt(pd.apps[0].amount.wei) > 0n);
  // executing the plan's requests exactly as printed enrolls every app
  for (const a of p.apps) for (const s of a.steps) await walletSends(o.key, s);
  for (const id of ids) { const r = await R(id, o.address); assert.equal(r.enabled, true); assert.equal(r.balanceWei, 2n * 10n ** 15n); }
  // the record is checked: a wrong digest is refused before any read
  const wrong = await cli(["lease-gas", "status", ids[0], "--lease-gas", recFile, "--lease-gas-digest", "sha256:" + "0".repeat(64)], { expectFail: true });
  assert.match(wrong.err, /not the reviewed/);
});

// A CREDIT VAULT owner of record (root review 2026-10-20, work/credit-vault-independence-interface.txt section 1). The
// fixture is the production configuration on the local chain: the d36100ae factory (test/fixtures/credit-vault-d36100ae.json,
// byte-identical to the live one) is deployed, then its runtime and its implementation's runtime are placed at the
// PRODUCTION addresses with only their immutable cross-references rewritten to those addresses; the vault is made by that
// factory's own createVault (an EIP-1167 CREATE2 clone) for a real P-256 key, and a deployment is transferred to it.
const CREDIT_VAULT_FIXTURE = path.join(ROOT, "../enclave/test/fixtures/credit-vault-d36100ae.json");
// the reviewed production binding, stated here independently of the module under test (it is compared at the end)
const CREDIT_VAULT = { factory: "0xa891e4396e3eb11f364554043bc18e86da834e91", implementation: "0xeca6644333d3a069001203ce5416914a4d830beb" };
const clone1167 = (impl) => `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
async function productionCreditVault() {
  const B = CREDIT_VAULT, cv = JSON.parse(fs.readFileSync(CREDIT_VAULT_FIXTURE, "utf8"));
  const local = await W.deploy({ abi: cv.factory.abi, bytecode: cv.factory.bytecode, links: {} },
    [W.addr.usdc, W.addr.registry, privateKeyToAccount(DEPLOYER).address, "https://enclave.host", ""]);
  const impl = await W.pc.readContract({ address: local, abi: cv.factory.abi, functionName: "implementation" });
  const word = (a) => a.slice(2).toLowerCase().padStart(64, "0");
  for (const [at, from, refs] of [[B.factory, local, [[impl, B.implementation]]], [B.implementation, impl, [[local, B.factory], [impl, B.implementation]]]]) {
    let code = (await W.pc.getCode({ address: from })).slice(2).toLowerCase();
    for (const [a, b] of refs) code = code.split(word(a)).join(word(b));
    assert.ok(code.includes(word(refs[0][1])), "the immutable cross-reference was rewritten");
    await W.rpc("anvil_setCode", [at, "0x" + code]);
  }
  const jwk = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ format: "jwk" });
  const [x, y] = [jwk.x, jwk.y].map((v) => BigInt("0x" + Buffer.from(v, "base64url").toString("hex")));
  await W.write(DEPLOYER, B.factory, cv.factory.abi, "createVault", [x, y]);
  const vault = await W.pc.readContract({ address: B.factory, abi: cv.factory.abi, functionName: "vaultFor", args: [x, y] });
  assert.equal((await W.pc.getCode({ address: vault })).toLowerCase(), clone1167(B.implementation), "the factory's own CREATE2 clone of the production implementation");
  assert.equal((await W.pc.readContract({ address: vault, abi: cv.vault.abi, functionName: "factory" })).toLowerCase(), B.factory);
  assert.equal(await W.pc.readContract({ address: vault, abi: cv.vault.abi, functionName: "keyCount" }), 1n);
  return vault;
}
const UNSUPPORTED = /credit vault of EnclaveCreditVault \(production factory, source d36100ae\) 0x[0-9a-fA-F]{40}; a credit vault is controlled by passkey signatures .*no reserve configure\/setClaimant\/withdraw entry point and no ownerCall/;

test("credit-vault owner (the production factory's clone): deposit, configure and claimant are refused, plan lists it refused; supported owners proceed", T, async () => {
  const vault = await productionCreditVault();
  const o = await W.owner();
  const idV = await W.create(o, { fund6: 0n });
  await W.write(o.key, W.addr.ledger, W.A.ledger.abi, "transferDeployment", [idV, vault]);
  assert.equal((await W.row(idV)).owner, vault);
  // status: the kind is named, the only advice is the refusal (never "deposit" or "configure")
  const s = (await cli(lg("status", idV))).json.apps[0];
  assert.equal(s.ownerKind.kind, "credit-vault"); assert.match(s.ownerKind.detail, /^UNSUPPORTED: EnclaveCreditVault \(production factory/);
  assert.equal(s.advice[0].level, "unsupported");
  assert.ok(!s.advice.some((x) => x.level === "action" || /lease-gas (deposit|configure)/.test(x.text)), JSON.stringify(s.advice));
  // deposit (from any payer), configure and claimant: refused before anything is prepared; nothing reaches the reserve
  for (const args of [[...lg("deposit", idV, "--eth", "0.01"), "--from", o.address], lg("deposit", idV, "--eth", "0.01"),
    lg("configure", idV, "--max-gas-price-gwei", "0.05"), lg("claimant", idV, o.address, "--allow")]) {
    const r = await cli(args, { expectFail: true });
    assert.match(r.err, UNSUPPORTED, args.slice(0, 3).join(" "));
    assert.equal(r.json, null, "no request was printed");
  }
  assert.equal((await R(idV, vault)).balanceWei, 0n);
  // plan: the credit-vault app is listed REFUSED (no steps, no amount); an EOA app and an ORIGINAL SessionVault app proceed
  const idE = await W.create(o);
  const vo = await W.owner();
  const F = art("SessionVault.sol", "SessionVaultFactory"), V = art("SessionVault.sol", "SessionVault");
  await W.write(vo.key, W.addr.vaultFactory, F.abi, "createVault", [vo.address]);
  const sv = await W.pc.readContract({ address: W.addr.vaultFactory, abi: F.abi, functionName: "vaultFor", args: [vo.address] });
  const createData = viem.encodeFunctionData({ abi: W.A.ledger.abi, functionName: "create", args: ["catalog://app/0", 0, 500, 8080, "", true, "", viem.zeroAddress, 0n, 1000n] });
  const { result } = await W.pc.simulateContract({ account: vo.address, address: sv, abi: V.abi, functionName: "ownerCall", args: [W.addr.ledger, createData] });
  await W.write(vo.key, sv, V.abi, "ownerCall", [W.addr.ledger, createData]);
  const idS = viem.decodeAbiParameters([{ type: "bytes32" }], result)[0];
  const p = (await cli(lg("plan", "--ids", [idE, idV, idS].join(","), "--max-gas-price-gwei", "0.05", "--per-app-eth", "0.002"))).json;
  const byId = Object.fromEntries(p.apps.map((a) => [a.id, a]));
  assert.equal(byId[idV].ownerKind.kind, "credit-vault"); assert.match(byId[idV].refused, UNSUPPORTED);
  assert.deepEqual(byId[idV].steps, []); assert.equal(byId[idV].amount, undefined);
  for (const [id, kind] of [[idE, "eoa"], [idS, "session-vault"]]) {
    assert.equal(byId[id].ownerKind.kind, kind);
    assert.deepEqual(byId[id].steps.map((x) => x.step), ["deposit", "configure"]);
    assert.ok(byId[id].steps.every((x) => x.simulated), JSON.stringify(byId[id].steps.map((x) => x.simError)));
  }
  assert.equal(BigInt(p.totalWei), 4n * 10n ** 15n, "only the two supported apps are funded");
  assert.ok(p.senders.every((x) => [o.address, vo.address].map((a) => a.toLowerCase()).includes(x.from.toLowerCase())), "no request from or for the credit vault");
  // the text plan says so too
  const t = await cli(lg("plan", "--ids", idV, "--max-gas-price-gwei", "0.05", "--per-app-eth", "0.002"), { json: false });
  assert.match(t.out, /\(credit-vault\): REFUSED - refusing to prepare a deposit or configuration/);
  // the module recognizes exactly the reviewed binding (no caller-supplied factory or implementation)
  assert.deepEqual(O.CREDIT_VAULT_FACTORIES?.map((b) => [b.chainId, b.factory, b.implementation]), [[8453, CREDIT_VAULT.factory, CREDIT_VAULT.implementation]]);
  assert.equal(O.eip1167Runtime?.(CREDIT_VAULT.implementation), clone1167(CREDIT_VAULT.implementation));
});

test("not every contract is a credit vault: a minimal proxy of ANOTHER implementation, and a 7702 EOA, keep their kinds", T, async () => {
  const B = CREDIT_VAULT;
  const o = await W.owner();
  const id = await W.create(o, { fund6: 0n });
  const lookalike = privateKeyToAccount(generatePrivateKey()).address;
  await W.rpc("anvil_setCode", [lookalike, clone1167(W.addr.usdc)]);   // the same proxy, another implementation
  await W.write(o.key, W.addr.ledger, W.A.ledger.abi, "transferDeployment", [id, lookalike]);
  const s = (await cli(lg("status", id))).json.apps[0];
  assert.equal(s.ownerKind.kind, "contract");
  const r = await cli(lg("configure", id, "--max-gas-price-gwei", "0.05"), { expectFail: true });
  assert.match(r.err, /neither an EOA, a SessionVault of a pinned factory nor a Safe/);
  assert.doesNotMatch(r.err, /credit vault/);
  // an EOA delegated (EIP-7702) to the credit-vault IMPLEMENTATION is still an EOA, not a vault
  const e = await W.owner(); const idE = await W.create(e);
  await W.rpc("anvil_setCode", [e.address, "0xef0100" + B.implementation.slice(2)]);
  try {
    const k = (await cli(lg("status", idE))).json.apps[0].ownerKind;
    assert.equal(k.kind, "eoa-7702");
  } finally { await W.rpc("anvil_setCode", [e.address, "0x"]); }
});
