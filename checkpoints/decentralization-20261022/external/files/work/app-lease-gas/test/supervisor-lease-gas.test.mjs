// The ACTUAL supervisor (work/app-lease-gas/shadow/supervisor.js: main's supervisor.js 51507084 + the lease-gas patch,
// everything else symlinked read-only to work/enclave) on the repo's own actual-host rig (test/helpers/
// cli-independent-rig.mjs: anvil, ledger, schema-4 registry, catalog, a fake VM manager), with:
//   - the actual EntryPoint v0.8 / Simple7702Account / SenderCreator code (fixtures/aa-code-base.json) set locally;
//   - EnclaveLeaseGasPaymaster deployed against the rig's ledger and registry, staked, one sponsor;
//   - a non-zero base fee (the rig runs at 0; gas must cost something for "the app paid" to mean anything);
//   - the ledger's leaseSec lowered to 120 s by its admin (so a renewal happens within the test).
// The supervisor's own claim loop claims the funded deployment and later renews it, through the paymaster, relayed by
// a local bundler-style endpoint (test/mini-bundler.mjs). A second deployment whose owner never authorized a budget is
// refused explicitly and left unclaimed (no self-pay fallback configured).
// Run: node --test test/supervisor-lease-gas.test.mjs   (cwd work/app-lease-gas)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as C from "../client/lease-gas-client.mjs";
import { startMiniBundler } from "./mini-bundler.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENCLAVE = path.resolve(ROOT, "../enclave");
const RIG = await import(pathToFileURL(path.join(ENCLAVE, "test/helpers/cli-independent-rig.mjs")).href);
const MR = await import(pathToFileURL(path.join(ENCLAVE, "test/helpers/move-release-rig.mjs")).href);
const SUPERVISOR = path.join(ROOT, "shadow/supervisor.js");
const skip = RIG.haveTools();
const T = skip ? { skip, timeout: 420_000 } : { timeout: 420_000 };
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(ROOT, "forge/out", file, name + ".json"), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const cleanups = [];
after(async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch {} } });

async function world() {
  const r = await RIG.startRig();
  cleanups.push(() => r.stop());
  const aa = JSON.parse(fs.readFileSync(path.join(ROOT, "fixtures/aa-code-base.json"), "utf8"));
  for (const c of Object.values(aa.contracts)) await r.rpcCall("anvil_setCode", [c.address, c.code]);
  // gas costs something: keep the next block's base fee at 0.01 gwei (the rig starts at 0)
  const fee = setInterval(() => r.rpcCall("anvil_setNextBlockBaseFeePerGas", ["0x989680"]).catch(() => {}), 100);
  cleanups.push(() => clearInterval(fee));
  const dep = r.wc(RIG.KEYS.deployer);
  const L = r.addresses.ledger;
  await r.write(dep, L, r.A.ledger.abi, "setLeaseSec", [120n]);

  // the paymaster against the rig's ledger and registry
  const A = { pm: art("EnclaveLeaseGasPaymaster.sol", "EnclaveLeaseGasPaymaster"), feed: art("LeaseGas.t.sol", "MockFeed") };
  const feed = await r.deploy(A.feed);
  const nowTs = (await r.pc.getBlock()).timestamp;
  await r.write(dep, feed, A.feed.abi, "set", [300000000000n, nowTs]);
  const limits = { maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 50_000_000n, maxVerificationGas: 150_000, minCallGas: 60_000,
    maxCallGas: 300_000, maxPreVerificationGas: 120_000, maxPaymasterVerificationGas: 300_000, minPostOpGas: 100_000, maxPostOpGas: 150_000,
    postOpChargeGas: 50_000, markupBps: 500, minRenewWindow: 30, maxRenewWindow: 900, minExtensionFloor: 60, maxFailures: 2 };
  const pm = await r.deploy(A.pm, [C.ENTRYPOINT_08, L, r.addresses.registry, r.addresses.usdc, C.SIMPLE_7702, 3600n, feed, 3600,
                                   100000000000n, 1000000000000n, limits]);
  const sendValue = async (fn, args, value) => r.pc.waitForTransactionReceipt({ hash: await dep.writeContract({ address: pm, abi: A.pm.abi, functionName: fn, args, value }) });
  await sendValue("addStake", [86400], 10n ** 18n);
  await sendValue("sponsorDeposit", [], 5n * 10n ** 16n);
  const sponsor = dep.account.address;

  // two apps by the same owner: one with an authorized budget, one without
  const owner = r.wc(RIG.KEYS.owner);
  const appRef = await MR.servableAppRef(r);
  const create = async () => r.createdId(await r.write(owner, L, r.A.ledger.abi, "create",
    [appRef, 0, 100, 3000, "http:3000", true, "", "0x0000000000000000000000000000000000000000", 0n, 100000n]));
  await r.write(owner, r.addresses.usdc, r.A.usdc.abi, "approve", [L, 20_000_000n]);
  await r.write(owner, r.addresses.usdc, r.A.usdc.abi, "approve", [pm, 20_000_000n]);
  const paid = await create();
  await r.write(owner, L, r.A.ledger.abi, "fund", [paid, 5_000_000n]);
  await r.write(owner, pm, A.pm.abi, "fundBudget", [paid, 1_000_000n]);
  await r.write(owner, pm, A.pm.abi, "configureBudget", [paid, true, 500_000n, 2_000_000n, 50, 60]);
  const unpaid = await create();
  await r.write(owner, L, r.A.ledger.abi, "fund", [unpaid, 5_000_000n]);

  // an independent submitter (its own funded key)
  const submitterKey = generatePrivateKey();
  await r.rpcCall("anvil_setBalance", [privateKeyToAccount(submitterKey).address, "0xde0b6b3a7640000"]);
  const results = [];
  const bundler = await startMiniBundler({ pc: r.pc, chain: RIG.chain, rpcUrl: r.rpc, key: submitterKey, onResult: (x) => results.push(x) });
  cleanups.push(() => bundler.close());

  return { r, A, pm, sponsor, owner, L, paid, unpaid, bundler, results };
}

/** Transactions the operator key itself sent in [fromBlock, head], and how many of them went to the ledger. */
async function operatorTxs(r, L, operator, fromBlock) {
  const head = await r.pc.getBlockNumber({ cacheTime: 0 });
  let ownLedgerTxs = 0, opTxs = 0;
  for (let n = fromBlock; n <= head; n++) {
    const blk = await r.pc.getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of blk.transactions) {
      if (viem.getAddress(tx.from) !== operator) continue;
      opTxs++;
      if (tx.to && viem.getAddress(tx.to) === viem.getAddress(L)) ownLedgerTxs++;
    }
  }
  return { head, opTxs, ownLedgerTxs };
}

test("the actual supervisor claims and renews through the app's gas budget; an unauthorized app is refused explicitly", T, async () => {
  const { r, A, pm, sponsor, owner, L, paid, unpaid, bundler, results } = await world();
  const operator = privateKeyToAccount(RIG.KEYS.operator).address;
  const fromBlock = await r.pc.getBlockNumber({ cacheTime: 0 });
  const b0 = (await r.pc.readContract({ address: pm, abi: A.pm.abi, functionName: "budgetOf", args: [paid, owner.account.address] })).balance6;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-gas-sup-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = await RIG.startActualHost(r, { id: paid, owner: owner.account.address, dir, token: "7c".repeat(32), claim: true, seed: false,
    script: SUPERVISOR, env: { LEASE_GAS_PAYMASTER: pm, LEASE_GAS_SPONSOR: sponsor, LEASE_GAS_BUNDLERS: bundler.url, RENEW_MARGIN_SEC: "600" } });
  cleanups.push(() => h.kill());

  // claim, by the supervisor's own claim loop, through the app's budget
  await h.waitLog(new RegExp(`\\[lease-gas\\] claim ${paid} sent to ${bundler.url.replace(/[.:/]/g, "\\$&")} as user operation 0x[0-9a-f]{64}`), 120000);
  await h.waitLog(new RegExp(`\\[claim\\] ${paid} adopted`), 120000);
  const row1 = await MR.getRow(r, paid);
  assert.equal(row1.runnerOperator, operator, "the supervisor's operator holds the lease");
  const b1 = (await r.pc.readContract({ address: pm, abi: A.pm.abi, functionName: "budgetOf", args: [paid, owner.account.address] })).balance6;
  assert.ok(b1 < b0, "the app's budget paid the claim");

  // the unauthorized app: refused explicitly, never claimed (no self-pay fallback configured)
  await h.waitLog(new RegExp(`\\[lease-gas\\] claim ${unpaid} refused: the app's owner has not authorized lease-gas sponsorship`), 120000);
  assert.match((await MR.getRow(r, unpaid)).runner, /^0x0{64}$/, "never claimed with the host's own ETH");

  // renew: only inside the owner's 50 s window before leaseUntil (the supervisor's own margin is 600 s)
  const from2 = h.stdout().length;
  await h.waitLog(new RegExp(`\\[lease-gas\\] renew ${paid} sent to`), 200000, from2);
  await h.waitLog(new RegExp(`\\[claim\\] ${paid} lease renewed`), 60000, from2);
  const row2 = await MR.getRow(r, paid);
  assert.ok(row2.leaseUntil > row1.leaseUntil, "renewed");
  const b2 = (await r.pc.readContract({ address: pm, abi: A.pm.abi, functionName: "budgetOf", args: [paid, owner.account.address] })).balance6;
  assert.ok(b2 < b1, "the app's budget paid the renewal");

  // the operator key sent NO claim/renew transaction of its own: every ledger call from it came through the EntryPoint
  const { head, opTxs, ownLedgerTxs } = await operatorTxs(r, L, operator, fromBlock);
  assert.equal(ownLedgerTxs, 0, "no ledger transaction paid by the operator key");
  const ok = results.filter((x) => x.success === true);
  assert.ok(ok.length >= 2, `the bundler landed the claim and the renewal: ${JSON.stringify(results.map((x) => x.success ?? x.error))}`);
  const charges = await r.pc.getContractEvents({ address: pm, abi: A.pm.abi, eventName: "LeaseGasCharged", fromBlock, toBlock: head });
  console.log(`# supervisor: ${charges.length} charge(s) for ${paid}: ${charges.map((c) => `${c.args.kind === 1 ? "claim" : "renew"} ${c.args.charged6}`).join(", ")} (USDC 6dp);`
    + ` operator-sent transactions in the window (registry etc.): ${opTxs}, of which to the ledger: ${ownLedgerTxs}`);
  assert.ok(charges.length >= 2 && charges.every((c) => c.args.id === paid && c.args.succeeded));
});

test("NEGATIVE CONTROL: main's unpatched supervisor, same world and env, pays claims from the operator key and the budget is never used", T, async () => {
  const { r, A, pm, sponsor, owner, L, paid, unpaid, bundler } = await world();
  const operator = privateKeyToAccount(RIG.KEYS.operator).address;
  const fromBlock = await r.pc.getBlockNumber({ cacheTime: 0 });
  const b0 = (await r.pc.readContract({ address: pm, abi: A.pm.abi, functionName: "budgetOf", args: [paid, owner.account.address] })).balance6;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-gas-sup-ctl-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = await RIG.startActualHost(r, { id: paid, owner: owner.account.address, dir, token: "7c".repeat(32), claim: true, seed: false,
    script: path.join(ENCLAVE, "supervisor.js"),
    env: { LEASE_GAS_PAYMASTER: pm, LEASE_GAS_SPONSOR: sponsor, LEASE_GAS_BUNDLERS: bundler.url, RENEW_MARGIN_SEC: "600" } });
  cleanups.push(() => h.kill());
  await h.waitLog(new RegExp(`\\[claim\\] ${paid} adopted`), 120000);
  await h.waitLog(new RegExp(`\\[claim\\] ${unpaid} adopted`), 120000);   // the unauthorized app is claimed too: self-paid
  const { opTxs, ownLedgerTxs } = await operatorTxs(r, L, operator, fromBlock);
  assert.ok(ownLedgerTxs >= 2, `the operator key paid its own claims (${ownLedgerTxs})`);
  assert.equal(bundler.received.length, 0, "nothing went to a bundler");
  assert.equal((await r.pc.readContract({ address: pm, abi: A.pm.abi, functionName: "budgetOf", args: [paid, owner.account.address] })).balance6, b0,
               "the app's budget was never used");
  assert.doesNotMatch(h.stdout(), /\[lease-gas\]/, "main's supervisor has no lease-gas path");
  console.log(`# control: operator-sent transactions ${opTxs}, of which to the ledger ${ownLedgerTxs}`);
});
