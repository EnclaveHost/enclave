// The ACTUAL supervisor.js against the frozen ledger rev-17 CANDIDATE (test/fixtures/lease17-candidate.json, from
// work/lease-generation-candidate; work/lease-generation-interface.txt) on a local anvil: lease generations end-to-end.
//   1  release names the lease: releaseLease(id, this runner, the generation read at a pinned block); a renew keeps the
//      generation; the unused tail is refunded to the balance; release(id) is never sent
//   2  a release and re-claim by this key land at an IDENTICAL leaseUntil (a balance-limited quantum); the restored intent
//      for generation 1 is never re-sent against generation 2
//   3  another operator claimed in between: the restored intent resolves gone, nothing is sent
//   4  an intent pending on its own (old) ledger after the pins move to a new ledger: resolved there, never re-sent
//   5  the supervisor's own claim records LeaseOpened's generation; the next release names generation 2
//   6  CONTROL on the live-equivalent rev-16 ledger: the same sequence as 2 ends the re-claimed lease (release(id), no
//      generation to tell them apart), and leaseOf is never called there (nothing inferred)
// No live chain, no real key: anvil's published dev keys only.
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak256, toBytes } from "viem";
import { haveTools, startRig, startActualHost, lease17Candidate, KEYS } from "./helpers/cli-independent-rig.mjs";
import { TOKEN, sleep, ownerAddress, operatorAddress, newLease, servableAppRef, getRow, login, api, startProxy, anyReleaseTxs, leaseOf,
  ledgerEvents, waitFor, claimLog, retire } from "./helpers/move-release-rig.mjs";
import { toFunctionSelector } from "viem";
const LEASE_OF = toFunctionSelector("leaseOf(bytes32)");

const SUPERVISOR = process.env.MOVE_TEST_SUPERVISOR || "supervisor.js";
const skip = haveTools();
const T = skip ? { skip, timeout: 240000 } : { timeout: 240000 };
let r, tmp, appRef;
const live = [], rigs = [];

before(async () => {
  if (skip) return;
  r = await startRig({ ledgerRev: 17 });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lease17-"));
  appRef = await servableAppRef(r);
});
after(async () => { for (const x of rigs) await x.stop(); if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
afterEach(async () => { for (const h of live.splice(0)) await h.kill(); if (r) await r.setMining(true); });

async function host(rig, id, leaseUntil, { dir = fs.mkdtempSync(path.join(tmp, "h-")), ...opts } = {}) {
  const h = await startActualHost(rig, { id, owner: ownerAddress, dir, token: TOKEN, leaseUntil, appRef: rig === r ? appRef : await servableAppRef(rig),
    script: SUPERVISOR, ...opts, env: { RELEASE_POLL_MS: "500", RELEASE_RETRY_SEC: "1", ...(opts.env || {}) } });
  live.push(h);
  return h;
}
const call = (rig, key, fn, args, ledger = rig.addresses.ledger) => rig.write(rig.wc(key), ledger, rig.A.ledger.abi, fn, args);
// the same key's OTHER process sends its own transaction: an explicit gas limit makes its bytes (and hash) differ from the
// supervisor's swallowed one, which would otherwise be byte-identical (same key, nonce, call and fees)
async function otherProcess(rig, key, fn, args) {
  const hash = await rig.wc(key).writeContract({ address: rig.addresses.ledger, abi: rig.A.ledger.abi, functionName: fn, args, gas: 2_000_000n });
  const rc = await rig.pc.waitForTransactionReceipt({ hash });
  if (rc.status !== "success") throw new Error(fn + " reverted");
  return rc;
}
const persisted = (file, id) => { const s = JSON.parse(fs.readFileSync(file, "utf8")); return (s.releaseIntents || []).find((i) => i.id === id) || null; };
// A release whose broadcast the proxy swallowed: its intent (and {hash, nonce}) persisted, then the process dies.
async function swallowedThenDie(h, id, proxy) {
  const tok = await login(h);
  proxy.mode.swallowRelease = true;
  api(h, "POST", `/v1/deployments/${id}/release`, tok).catch(() => {});
  await waitFor(() => proxy.swallowed[0] || null, 30000, "the swallowed release");
  await sleep(2500);
  await h.kill();
  const it = persisted(h.stateFile, id);
  assert.ok(it && it.txs[0], "the intent and its transaction identity were persisted before the broadcast");
  return it;
}

test("1: the supervisor names the lease it ends (releaseLease with the pinned generation); renew keeps the generation; the tail is refunded", T, async () => {
  const { id } = await newLease(r);
  const l1 = await leaseOf(r, id);
  assert.equal(l1[3], 1n, "the first claim opened generation 1");
  await call(r, KEYS.operator, "renew", [id]);
  const l2 = await leaseOf(r, id);
  assert.equal(l2[3], 1n, "a renewal continues the same lease"); assert.ok(l2[2] > l1[2], "and extends it");
  const h = await host(r, id, l2[2]);
  const tok = await login(h);
  const from = await r.pc.getBlockNumber({ cacheTime: 0 }), before = await getRow(r, id);
  const x = await api(h, "POST", `/v1/deployments/${id}/release`, tok);
  assert.equal(x.status, 200, JSON.stringify(x.json)); assert.equal(x.json.released, true); assert.equal(x.json.generation, "1");
  const rel = await anyReleaseTxs(r, from, { id });
  assert.equal(rel.length, 1, "one release transaction");
  assert.deepEqual([rel[0].kind, rel[0].runner.toLowerCase(), rel[0].generation, rel[0].success, rel[0].hash], ["releaseLease", r.runner.toLowerCase(), 1n, true, x.json.txHash]);
  const ev = (await ledgerEvents(r, from, id)).find((e) => e.eventName === "Released");
  const after = await getRow(r, id);
  assert.ok(ev.args.refunded6 > 0n, "the unused tail was refunded");
  assert.equal(after.balance6 - before.balance6, ev.args.refunded6, "exactly the refunded tail went back to the deployment's balance");
  const l3 = await leaseOf(r, id);
  assert.match(l3[0], /^0x0{64}$/); assert.equal(l3[3], 1n, "release keeps the generation; the next claim moves past it");
  assert.match(h.stdout(), new RegExp(`\\[release\\] ${id} releaseLease generation 1 1/4 signed`));
  await retire(r, id);
});

test("2: a release + re-claim by this key at an IDENTICAL leaseUntil: the restored intent for generation 1 is never re-sent against generation 2", T, async () => {
  // a balance-limited quantum: a release refunds the tail and the re-claim burns it again, landing at the same leaseUntil
  const { id } = await newLease(r, { fund: 50_000n });
  const l1 = await leaseOf(r, id), row = await getRow(r, id);
  const now = Number((await r.pc.getBlock()).timestamp);
  assert.ok(Number(l1[2]) - now < 1800, `the quantum must be balance-limited for this case (rate ${row.rate}/s)`);
  const proxy = await startProxy(r);
  const dir = fs.mkdtempSync(path.join(tmp, "h2-"));
  const h1 = await host(r, id, l1[2], { dir, rpc: proxy.url });
  const it = await swallowedThenDie(h1, id, proxy);
  assert.equal(it.generation, "1"); assert.equal(it.schema, 17);
  // this key's other process (or the same host after a crash): ends generation 1 at the swallowed transaction's nonce, then
  // re-claims for the same runner
  const rc = await otherProcess(r, KEYS.operator, "releaseLease", [id, r.runner, 1n]);
  assert.notEqual(rc.transactionHash, it.txs[0].hash);
  assert.equal(Number((await r.pc.getTransaction({ hash: rc.transactionHash })).nonce), it.txs[0].nonce, "the swallowed release's nonce is now consumed");
  await call(r, KEYS.operator, "claim", [id, r.runner]);
  const l2 = await leaseOf(r, id);
  assert.deepEqual([l2[0].toLowerCase(), l2[1].toLowerCase(), l2[3]], [r.runner.toLowerCase(), operatorAddress.toLowerCase(), 2n]);
  assert.equal(l2[2], l1[2], "IDENTICAL leaseUntil: runner, operator and leaseUntil name generation 2 exactly as they named generation 1");
  const from = await r.pc.getBlockNumber({ cacheTime: 0 });
  const h2 = await host(r, id, l2[2], { dir, stateFile: h1.stateFile, seed: false });
  await h2.waitLog(/\[release\] restored 1 unresolved release/, 15000);
  await h2.waitLog(new RegExp(`\\[release\\] ${id} gone`), 60000);
  await sleep(3000);
  assert.deepEqual(await anyReleaseTxs(r, from, { id }), [], "nothing was sent against generation 2" + claimLog(h2));
  const l3 = await leaseOf(r, id);
  assert.deepEqual([l3[0].toLowerCase(), l3[2], l3[3]], [r.runner.toLowerCase(), l1[2], 2n], "generation 2 stands");
  await retire(r, id);
});

test("3: another operator claimed after this host's pending release: the restored intent resolves gone and sends nothing", T, async () => {
  const OTHER_ENDPOINT = "https://other-operator.lease17.test", OTHER = keccak256(toBytes(OTHER_ENDPOINT));
  await r.write(r.wc(KEYS.other), r.addresses.registry, r.A.registry4.abi, "register", [OTHER_ENDPOINT, "independent/host", "0x" + "00".repeat(32), 1000n, 0n,
    "0x0000000000000000000000000000000000000000"]);
  const { id } = await newLease(r);
  const l1 = await leaseOf(r, id);
  const proxy = await startProxy(r);
  const dir = fs.mkdtempSync(path.join(tmp, "h3-"));
  const h1 = await host(r, id, l1[2], { dir, rpc: proxy.url });
  const it = await swallowedThenDie(h1, id, proxy);
  await otherProcess(r, KEYS.operator, "releaseLease", [id, r.runner, 1n]);
  await call(r, KEYS.other, "claim", [id, OTHER]);
  const l2 = await leaseOf(r, id);
  assert.deepEqual([l2[0].toLowerCase(), l2[3]], [OTHER.toLowerCase(), 2n]);
  const from = await r.pc.getBlockNumber({ cacheTime: 0 });
  const h2 = await host(r, id, l1[2], { dir, stateFile: h1.stateFile, seed: false });
  await h2.waitLog(new RegExp(`\\[release\\] ${id} gone`), 60000);
  await sleep(2000);
  assert.deepEqual(await anyReleaseTxs(r, from, { id }), [], "nothing was sent" + claimLog(h2));
  assert.equal((await leaseOf(r, id))[0].toLowerCase(), OTHER.toLowerCase(), "the other operator's lease stands");
  assert.equal(it.generation, "1");
  await retire(r, id);
});

test("4: an intent pending on its own ledger when the pins move to a new ledger is resolved there and never re-sent to the new one", T, async () => {
  const { id } = await newLease(r);
  const l1 = await leaseOf(r, id);
  const proxy = await startProxy(r);
  const dir = fs.mkdtempSync(path.join(tmp, "h4-"));
  const h1 = await host(r, id, l1[2], { dir, rpc: proxy.url });
  const it = await swallowedThenDie(h1, id, proxy);
  assert.equal(it.ledger, r.addresses.ledger.toLowerCase());
  // the migration's new ledger (the same candidate code, the same libraries), and pins that name it
  const C17 = lease17Candidate();
  const ledgerB = await r.deploy(C17.ledger, [r.addresses.usdc, "0x00000000000000000000000000000000000e2e01", r.addresses.registry, "0x0000000000000000000000000000000000000000"],
    { "EnclaveDeployments.sol:EnclaveLedgerBandwidth": r.addresses.bw, "EnclaveDeployments.sol:EnclaveLeaseGeneration": r.addresses.leaseGeneration });
  const pinsB = { ...r.pins, contracts: { ...r.pins.contracts, deployments: ledgerB.toLowerCase() } };
  const from = await r.pc.getBlockNumber({ cacheTime: 0 });
  const h2 = await host(r, id, l1[2], { dir, stateFile: h1.stateFile, seed: false, pins: pinsB, env: { RELEASE_FENCE_SEC: "5" } });
  await h2.waitLog(new RegExp(`\\[release\\] ${id} ledger-moved`), 90000);
  await sleep(2000);
  assert.deepEqual(await anyReleaseTxs(r, from, { id, ledger: r.addresses.ledger }), [], "not re-sent on its own ledger after resolution");
  assert.deepEqual(await anyReleaseTxs(r, from, { ledger: ledgerB }), [], "and never sent to the new ledger");
  const head = await r.pc.getBlockNumber({ cacheTime: 0 });
  for (let b = from; b <= head; b++)
    for (const tx of (await r.pc.getBlock({ blockNumber: b, includeTransactions: true })).transactions)
      assert.notEqual(tx.to?.toLowerCase(), ledgerB.toLowerCase(), "no transaction of any kind went to the new ledger");
  assert.equal(await r.pc.getTransaction({ hash: it.txs[0].hash }).catch(() => null), null, "the swallowed release never existed on chain");
  const l2 = await leaseOf(r, id);
  assert.deepEqual([l2[0].toLowerCase(), l2[3]], [r.runner.toLowerCase(), 1n], "the old ledger's lease is untouched (it lapses there)");
  await retire(r, id);
});

test("5: the supervisor's own claim records LeaseOpened's generation; after the stand-down its next release names generation 2", T, async () => {
  const { id } = await newLease(r);
  const l1 = await leaseOf(r, id);
  const h = await host(r, id, l1[2], { claim: true });
  await h.waitLog(/\[registry\] registered/, 30000); await h.waitLog(/\[ledger\] full pass/, 30000);
  const tok = await login(h);
  const x = await api(h, "POST", `/v1/deployments/${id}/release`, tok);
  assert.equal(x.status, 200, JSON.stringify(x.json)); assert.equal(x.json.generation, "1");
  // no other host: after its 30 s stand-down this host claims it back, and the claim receipt's LeaseOpened names generation 2
  await h.waitLog(new RegExp(`\\[claim\\] ${id} adopted: .* generation 2`), 120000, h.stdout().length);
  const l2 = await leaseOf(r, id);
  assert.deepEqual([l2[0].toLowerCase(), l2[3]], [r.runner.toLowerCase(), 2n]);
  const from = await r.pc.getBlockNumber({ cacheTime: 0 });
  const y = await api(h, "POST", `/v1/deployments/${id}/release`, await login(h));
  assert.equal(y.status, 200, JSON.stringify(y.json)); assert.equal(y.json.generation, "2");
  const rel = await anyReleaseTxs(r, from, { id });
  assert.deepEqual(rel.map((t) => [t.kind, t.generation]), [["releaseLease", 2n]]);
  await retire(r, id);
});

test("6: CONTROL on the rev-16 ledger: the same identical-leaseUntil sequence ends the re-claimed lease; leaseOf is never called", T, async () => {
  const r16 = await startRig();
  rigs.push(r16);
  const { id } = await newLease(r16, { fund: 50_000n });
  const row1 = await getRow(r16, id);
  const proxy = await startProxy(r16);
  const dir = fs.mkdtempSync(path.join(tmp, "h6-"));
  const h1 = await host(r16, id, row1.leaseUntil, { dir, rpc: proxy.url });
  const it = await swallowedThenDie(h1, id, proxy);
  assert.equal(it.generation, null); assert.ok(it.schema < 17, `schema ${it.schema}`);
  await otherProcess(r16, KEYS.operator, "release", [id]);
  await call(r16, KEYS.operator, "claim", [id, r16.runner]);
  const row2 = await getRow(r16, id);
  assert.equal(row2.leaseUntil, row1.leaseUntil, "the identical leaseUntil, on rev 16 too");
  const from = await r16.pc.getBlockNumber({ cacheTime: 0 });
  const h2 = await host(r16, id, row2.leaseUntil, { dir, stateFile: h1.stateFile, seed: false, rpc: proxy.url });
  await h2.waitLog(new RegExp(`\\[release\\] ${id} released`), 90000);
  const rel = await anyReleaseTxs(r16, from, { id, ledger: r16.addresses.ledger });
  assert.deepEqual(rel.map((t) => [t.kind, t.success]), [["release", true]],
    "the boundary rev 17 closes: an unnamed release(id) cannot tell the re-claimed lease from the one it meant");
  assert.match((await getRow(r16, id)).runner, /^0x0{64}$/, "the re-claimed lease was ended");
  assert.ok(proxy.calls.some((c) => c.to === r16.addresses.ledger.toLowerCase()), "the supervisor read the ledger through the proxy");
  assert.equal(proxy.calls.filter((c) => c.selector === LEASE_OF).length, 0, "on rev 16 leaseOf is never called: nothing is inferred");
});
