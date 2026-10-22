// Design B with the ACTUAL supervisor (work/app-lease-gas/shadow-b/supervisor.js = main's current supervisor.js + the
// design-B hunk; everything else symlinked read-only to work/enclave) on the repo's own actual-host rig
// (test/helpers/cli-independent-rig.mjs). EnclaveLeaseGasReserve + EnclaveLeaseExecutor are deployed against the
// rig's ledger and registry; two open relays (client/lease-executor-client.mjs startLeaseRelay) plus one dead URL.
// A non-zero base fee is forced (the rig runs at 0) and the ledger admin lowers leaseSec to 120 s so a renewal happens.
//   - the supervisor's own claim loop claims the funded app and later renews it, through the relays, the app paying;
//   - an app whose owner never enabled a reserve is refused in words and left unclaimed (no ETH fallback);
//   - the owner's release route (used by move/stop) releases through the DURABLE release intent, sponsored: the intent
//     records the signed lease's executor nonce and deadline, resolves by the relay transaction's receipt;
//   - the operator key sends NO ledger transaction at all.
// Plus a NEGATIVE CONTROL: main's unpatched supervisor in the same world pays its own claims and never uses the reserve.
// Run: node --test test/supervisor-lease-executor.test.mjs   (cwd work/app-lease-gas)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as viem from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import * as B from "../client/lease-executor-client.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENCLAVE = path.resolve(ROOT, "../enclave");
const RIG = await import(pathToFileURL(path.join(ENCLAVE, "test/helpers/cli-independent-rig.mjs")).href);
const MR = await import(pathToFileURL(path.join(ENCLAVE, "test/helpers/move-release-rig.mjs")).href);
const SUPERVISOR = path.join(ROOT, "shadow-b/supervisor.js");
const skip = RIG.haveTools();
const T = skip ? { skip, timeout: 480_000 } : { timeout: 480_000 };
const art = (file, name) => { const j = JSON.parse(fs.readFileSync(path.join(ROOT, "forge/out", file, name + ".json"), "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object, linkReferences: j.bytecode.linkReferences || {} }; };
const cleanups = [];
after(async () => { while (cleanups.length) { try { await cleanups.pop()(); } catch {} } });
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

async function world() {
  const r = await RIG.startRig();
  cleanups.push(() => r.stop());
  const fee = setInterval(() => r.rpcCall("anvil_setNextBlockBaseFeePerGas", ["0x989680"]).catch(() => {}), 100);
  cleanups.push(() => clearInterval(fee));
  const dep = r.wc(RIG.KEYS.deployer);
  const L = r.addresses.ledger;
  await r.write(dep, L, r.A.ledger.abi, "setLeaseSec", [120n]);
  const A = { reserve: art("EnclaveLeaseGasReserve.sol", "EnclaveLeaseGasReserve"), executor: art("EnclaveLeaseExecutor.sol", "EnclaveLeaseExecutor") };
  const reserve = await r.deploy(A.reserve, [L, r.addresses.registry, "0x0000000000000000000000000000000000000000",
    { maxGasPriceCeiling: 10n ** 9n, overheadClaimGas: 29_500, overheadRenewGas: 24_000, overheadReleaseGas: 7_000, minClaimInterval: 60, l1Bps: 0 }]);
  const executor = await r.deploy(A.executor, [reserve]);
  await r.write(dep, reserve, A.reserve.abi, "bindExecutor", [executor]);
  const owner = r.wc(RIG.KEYS.owner);
  const appRef = await MR.servableAppRef(r);
  const create = async () => r.createdId(await r.write(owner, L, r.A.ledger.abi, "create",
    [appRef, 0, 100, 3000, "http:3000", true, "", "0x0000000000000000000000000000000000000000", 0n, 100000n]));
  await r.write(owner, r.addresses.usdc, r.A.usdc.abi, "approve", [L, 20_000_000n]);
  const paid = await create();
  await r.write(owner, L, r.A.ledger.abi, "fund", [paid, 5_000_000n]);
  const val = async (to, abi, fn, args, value) => r.pc.waitForTransactionReceipt({ hash: await owner.writeContract({ address: to, abi, functionName: fn, args, value }) });
  await val(reserve, A.reserve.abi, "deposit", [paid], 10n ** 16n);
  await r.write(owner, reserve, A.reserve.abi, "configure", [paid, { enabled: true, claimPolicy: 0, sponsorRelease: true, maxClaimsPerEpoch: 4,
    maxPerOpWei: 10n ** 15n, epochCapWei: 5n * 10n ** 15n, epochSec: 3600, renewWindow: 50, minExtension: 60, claimCooldown: 120, maxGasPrice: 10n ** 8n }]);
  const unpaid = await create();
  await r.write(owner, L, r.A.ledger.abi, "fund", [unpaid, 5_000_000n]);
  const relays = [];
  for (let i = 0; i < 2; i++) {
    const k = generatePrivateKey();
    await r.rpcCall("anvil_setBalance", [privateKeyToAccount(k).address, "0xde0b6b3a7640000"]);
    relays.push(await B.startLeaseRelay({ client: r.pc, wallet: viem.createWalletClient({ chain: RIG.chain, account: privateKeyToAccount(k), transport: viem.http(r.rpc) }) }));
  }
  cleanups.push(async () => { for (const x of relays) await x.close(); });
  return { r, A, L, reserve, executor, owner, paid, unpaid, relays };
}

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

test("the actual supervisor claims, renews and RELEASES through the app's reserve via relays; an unauthorized app is refused", T, async () => {
  const { r, A, L, reserve, executor, owner, paid, unpaid, relays } = await world();
  const operator = privateKeyToAccount(RIG.KEYS.operator).address;
  const fromBlock = await r.pc.getBlockNumber({ cacheTime: 0 });
  const b0 = (await r.pc.readContract({ address: reserve, abi: A.reserve.abi, functionName: "reserveOf", args: [paid, owner.account.address] })).balanceWei;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-exec-sup-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = await RIG.startActualHost(r, { id: paid, owner: owner.account.address, dir, token: "7c".repeat(32), claim: true, seed: false, script: SUPERVISOR,
    env: { LEASE_GAS_RESERVE: reserve, LEASE_GAS_RELAYS: ["http://127.0.0.1:1", relays[0].url, relays[1].url].join(","), RENEW_MARGIN_SEC: "600" } });
  cleanups.push(() => h.kill());

  await h.waitLog(new RegExp(`\\[lease-gas\\] claim ${paid} relayed by http://127\\.0\\.0\\.1:\\d+ in 0x[0-9a-f]{64} \\(carrying this key's 7702 delegation\\)`), 120000);
  await h.waitLog(new RegExp(`\\[claim\\] ${paid} adopted`), 120000);
  const row1 = await MR.getRow(r, paid);
  assert.equal(row1.runnerOperator, operator);
  assert.equal((await r.pc.getCode({ address: operator })).toLowerCase(), viem.concat(["0xef0100", executor]).toLowerCase(), "delegated by its first lease");
  await h.waitLog(new RegExp(`\\[lease-gas\\] claim ${unpaid} refused: claim ${unpaid} refused: the app's owner has not enabled a lease-gas reserve`), 120000);
  assert.match((await MR.getRow(r, unpaid)).runner, /^0x0{64}$/, "never claimed with the host's own ETH");

  const from2 = h.stdout().length;
  await h.waitLog(new RegExp(`\\[lease-gas\\] renew ${paid} relayed by`), 240000, from2);
  await h.waitLog(new RegExp(`\\[claim\\] ${paid} lease renewed`), 60000, from2);
  assert.ok((await MR.getRow(r, paid)).leaseUntil > row1.leaseUntil, "renewed");

  // the owner's release route (what move and stop use): a durable, sponsored release
  const tok = await MR.login(h);
  const x = await MR.api(h, "POST", `/v1/deployments/${paid}/release`, tok);
  assert.equal(x.status, 200, JSON.stringify(x.json));
  assert.equal(x.json.released, true, JSON.stringify(x.json));
  assert.match(h.stdout(), new RegExp(`\\[release\\] ${paid} sponsored release 1/\\d+ lease nonce \\d+ \\(.*relay accepted 0x[0-9a-f]{64}\\); the app's reserve pays`));
  assert.match((await MR.getRow(r, paid)).runnerOperator, /^0x0{40}$/i, "released");
  const state = JSON.parse(fs.readFileSync(h.stateFile, "utf8"));
  const intents = (state.releaseIntents || []).filter((i) => i.id === paid);
  assert.ok(intents.every((i) => i.txs.every((t) => t.sponsored === true)), "every release transaction of the intent was a sponsored one");

  const { opTxs, ownLedgerTxs } = await operatorTxs(r, L, operator, fromBlock);
  assert.equal(ownLedgerTxs, 0, "no ledger transaction paid by the operator key (claim, renew and release all relayed)");
  const paidEvents = await r.pc.getContractEvents({ address: reserve, abi: A.reserve.abi, eventName: "LeaseGasPaid", fromBlock });
  const kinds = paidEvents.filter((e) => e.args.id === paid).map((e) => ["", "claim", "renew", "release"][e.args.kind]);
  console.log(`# supervisor B: reserve paid ${kinds.join(", ")} for ${paid}; operator-sent transactions ${opTxs} (registry etc.), to the ledger ${ownLedgerTxs}`);
  assert.deepEqual([...new Set(kinds)].sort(), ["claim", "release", "renew"]);
  const b1 = (await r.pc.readContract({ address: reserve, abi: A.reserve.abi, functionName: "reserveOf", args: [paid, owner.account.address] })).balanceWei;
  assert.equal(b0 - b1, paidEvents.filter((e) => e.args.id === paid).reduce((a, e) => a + e.args.chargedWei, 0n), "the reserve paid exactly the relays");
});

test("NEGATIVE CONTROL: main's unpatched supervisor in the same world pays claims from the operator key; the reserve is never used", T, async () => {
  const { r, A, L, reserve, owner, paid, unpaid, relays } = await world();
  const operator = privateKeyToAccount(RIG.KEYS.operator).address;
  const fromBlock = await r.pc.getBlockNumber({ cacheTime: 0 });
  const b0 = (await r.pc.readContract({ address: reserve, abi: A.reserve.abi, functionName: "reserveOf", args: [paid, owner.account.address] })).balanceWei;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-exec-ctl-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = await RIG.startActualHost(r, { id: paid, owner: owner.account.address, dir, token: "7c".repeat(32), claim: true, seed: false,
    script: path.join(ENCLAVE, "supervisor.js"), env: { LEASE_GAS_RESERVE: reserve, LEASE_GAS_RELAYS: relays[0].url, RENEW_MARGIN_SEC: "600" } });
  cleanups.push(() => h.kill());
  await h.waitLog(new RegExp(`\\[claim\\] ${paid} adopted`), 120000);
  await h.waitLog(new RegExp(`\\[claim\\] ${unpaid} adopted`), 120000);
  const { ownLedgerTxs } = await operatorTxs(r, L, operator, fromBlock);
  assert.ok(ownLedgerTxs >= 2, `the operator key paid its own claims (${ownLedgerTxs})`);
  assert.equal((await r.pc.readContract({ address: reserve, abi: A.reserve.abi, functionName: "reserveOf", args: [paid, owner.account.address] })).balanceWei, b0);
  assert.doesNotMatch(h.stdout(), /\[lease-gas\]/);
  console.log(`# control B: operator-sent ledger transactions ${ownLedgerTxs}; reserve untouched`);
});
