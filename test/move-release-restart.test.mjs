// Restart and recovery of a PENDING lease release on the ACTUAL supervisor.js (work/independent-move-fix-interface.txt):
// a release() signed by a process that then dies can still land, and it ends whatever lease the operator holds then. The
// state file keeps its public identity ({hash, nonce}: never the key, never the signed bytes), the next process holds
// the deployment until that transaction is resolved, and with the state LOST the boot-time nonce fence holds every
// resume until the operator's transactions from before the boot have resolved. Real claim loop, ledger and registry on
// anvil (as test/move-release-durable.test.mjs); MOVE_TEST_SUPERVISOR=<file> runs the cases against another supervisor.
//   C   restart, state kept, the release in the mempool; the RPC's own pending view hides it (only the intent holds)
//   C2  restart, state LOST, the release in the mempool (only the boot fence holds)
//   D2  restart, state kept, the release never reached any mempool (unknown, resolved by its nonce)
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { haveTools, startRig, startActualHost, KEYS } from "./helpers/cli-independent-rig.mjs";
import { TOKEN, RELEASE_SELECTOR, sleep, ownerAddress, operatorAddress, newLease, servableAppRef, getRow, login, api, startProxy,
  releaseTxs, ledgerEvents, pendingFrom, waitFor, launchesWithoutNewLease, launchesOf, retire, claimLog } from "./helpers/move-release-rig.mjs";

const SUPERVISOR = process.env.MOVE_TEST_SUPERVISOR || "supervisor.js";
const skip = haveTools();
const T = skip ? { skip, timeout: 240000 } : { timeout: 240000 };
let r, tmp, appRef;
const live = [];

before(async () => {
  if (skip) return;
  r = await startRig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "move-restart-"));
  appRef = await servableAppRef(r);
});
after(async () => { if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
afterEach(async () => { for (const h of live.splice(0)) await h.kill(); await r.setMining(true); });

async function host(id, leaseUntil, { dir, ...opts }) {
  const h = await startActualHost(r, { id, owner: ownerAddress, dir, token: TOKEN, leaseUntil, appRef, script: SUPERVISOR, claim: true,
    ...opts, env: { RELEASE_POLL_MS: "500", ...(opts.env || {}) } });
  live.push(h);
  await h.waitLog(/\[registry\] (?:registered|adopted the existing registration)/, 30000);
  return h;
}
const persisted = (file, id) => { const s = JSON.parse(fs.readFileSync(file, "utf8")); return (s.releaseIntents || []).find((i) => i.id === id) || null; };
// The state file names transactions only by their public identity
function assertPublicOnly(file) {
  const raw = fs.readFileSync(file, "utf8").toLowerCase();
  assert.ok(!raw.includes(KEYS.operator.slice(2).toLowerCase()), "the operator key is not in the state file");
  assert.ok(!/0x[0-9a-f]{300,}/.test(raw), "no signed transaction bytes in the state file");
}
// A release in flight from h, killed once the chain side shows it was signed (`signed()`: in the mempool, or dropped by the
// proxy) and the state file has had its periodic flush. -> {hash, nonce} as the CHAIN side saw it, and the persisted
// intent (null when the supervisor persists none: the pre-fix code, run as the negative control)
async function releaseThenDie(h, id, tok, signed) {
  api(h, "POST", `/v1/deployments/${id}/release`, tok).catch(() => {});   // its answer dies with the process
  const seen = await waitFor(signed, 30000, "the signed release");
  await sleep(2500);
  await h.kill();
  return { seen, it: persisted(h.stateFile, id) };
}
const inMempool = async () => (await pendingFrom(r, operatorAddress)).find((x) => x.input.startsWith(RELEASE_SELECTOR)) || null;

test("C: restart with the release in the mempool and the RPC's pending view hiding it: the restored intent alone holds the lease; nothing re-sent; resolves when mined", T, async (t) => {
  const proxy = await startProxy(r);
  const { id, leaseUntil } = await newLease(r);
  const dir = fs.mkdtempSync(path.join(tmp, "c-"));
  const h1 = await host(id, leaseUntil, { dir, rpc: proxy.url });
  await h1.waitLog(/\[ledger\] full pass/, 30000);
  const tok = await login(h1);
  const from = await r.pc.getBlockNumber();
  await r.setMining(false);
  const { seen, it } = await releaseThenDie(h1, id, tok, inMempool);
  assertPublicOnly(h1.stateFile);
  // the next process's RPC does not show it pending, so the boot fence sees nothing in flight: only the restored intent holds
  proxy.mode.pendingAsLatest = true;
  const h2 = await host(id, leaseUntil, { dir, rpc: proxy.url, stateFile: h1.stateFile, seed: false });
  await sleep(15000);   // ~7 claim passes; the ledger still shows this host's live lease
  assert.equal((await getRow(r, id)).runner.toLowerCase(), r.runner.toLowerCase(), "the release is still unmined");
  assert.equal(launchesOf(h2, id), 0, "not resumed onto a lease the restored release may still end" + claimLog(h2));
  assert.ok(it, "the release's identity was persisted before it could land");
  assert.equal(it.txs[0].hash, seen.hash); assert.equal(it.txs[0].nonce, seen.nonce);
  assert.match(h2.stdout(), /\[release\] restored 1 unresolved release/);
  assert.match(h2.stdout(), /no operator transaction from before this boot is still in flight/, "the boot fence saw nothing pending");
  assert.match(h2.stdout(), new RegExp(`${id}: a release of this deployment from this host is unresolved \\(transaction ${seen.hash}`));
  assert.equal((await pendingFrom(r, operatorAddress)).filter((x) => x.input.startsWith(RELEASE_SELECTOR)).length, 1, "nothing re-sent");
  proxy.mode.pendingAsLatest = false;
  await r.setMining(true);
  await h2.waitLog(new RegExp(`\\[release\\] ${id} released \\(owner move; 1 transaction`), 30000);
  const rel = await releaseTxs(r, from, id);
  assert.equal(rel.length, 1); assert.equal(rel[0].hash, seen.hash); assert.ok(rel[0].success);
  assert.equal(persisted(h2.stateFile, id), null, "the resolved intent left the state file");
  // the stand-down was persisted and runs from resolution: no claim back for the next 15 s
  const l = launchesOf(h2, id);
  await sleep(15000);
  assert.equal(launchesOf(h2, id), l);
  await retire(r, id);
  t.diagnostic(`release ${seen.hash} nonce ${seen.nonce} held across the restart, mined once`);
});

test("C2: restart with the state LOST while the release is in the mempool: the boot fence holds every resume until it resolves", T, async (t) => {
  const { id, leaseUntil } = await newLease(r);
  const h1 = await host(id, leaseUntil, { dir: fs.mkdtempSync(path.join(tmp, "c2a-")) });
  await h1.waitLog(/\[ledger\] full pass/, 30000);
  const tok = await login(h1);
  const from = await r.pc.getBlockNumber();
  await r.setMining(false);
  const t0 = Date.now();
  const { seen } = await releaseThenDie(h1, id, tok, inMempool);
  // a new process with NO state: no record, no intent, no stand-down. It sees its own live lease and would resume it.
  const dir2 = fs.mkdtempSync(path.join(tmp, "c2b-"));
  const h2 = await host(id, leaseUntil, { dir: dir2, stateFile: path.join(dir2, "fresh-state.json"), seed: false });
  await sleep(15000);
  assert.equal((await getRow(r, id)).runner.toLowerCase(), r.runner.toLowerCase(), "the release is still unmined");
  assert.equal(launchesOf(h2, id), 0, "no resume while a transaction from before the boot may still land" + claimLog(h2));
  assert.match(h2.stdout(), /transactions in flight at boot/);
  assert.match(h2.stdout(), new RegExp(`${id}: this operator's transactions from before this boot are not resolved yet`));
  await r.setMining(true);
  await h2.waitLog(/no operator transaction from before this boot is still in flight/, 30000);
  await sleep(6000);
  const rel = await releaseTxs(r, from, id);
  assert.equal(rel.length, 1); assert.equal(rel[0].hash, seen.hash);
  // the lease the release ended is never served; anything this host runs now runs under a lease claimed after it
  const ev = await ledgerEvents(r, from, id);
  assert.deepEqual(await launchesWithoutNewLease(r, h2, from, id, t0), [], "every launch ran under a lease claimed after the release");
  await retire(r, id);
  t.diagnostic(`after the fence: ${launchesOf(h2, id)} launch(es), ${ev.filter((e) => e.eventName === "Claimed").length} claim(s) after the release`);
});

test("D2: restart after a release no mempool ever saw: held as unknown until its nonce is consumed, then decided again on the ledger", T, async (t) => {
  const proxy = await startProxy(r);
  const { id, leaseUntil } = await newLease(r);
  const dir = fs.mkdtempSync(path.join(tmp, "d2-"));
  const env = { RELEASE_FENCE_SEC: "20", RELEASE_RETRY_SEC: "1" };
  const h1 = await host(id, leaseUntil, { dir, rpc: proxy.url, env });
  await h1.waitLog(/\[ledger\] full pass/, 30000);
  const tok = await login(h1);
  const from = await r.pc.getBlockNumber();
  proxy.mode.swallowRelease = true;
  const t0 = Date.now();
  const { seen, it } = await releaseThenDie(h1, id, tok, () => proxy.swallowed[0] || null);
  const h2 = await host(id, leaseUntil, { dir, rpc: proxy.url, env, stateFile: h1.stateFile, seed: false });
  await sleep(10000);
  assert.equal(launchesOf(h2, id), 0, "not resumed while a release of the lease is unknown, nor in the stand-down after it" + claimLog(h2));
  await waitFor(async () => (await releaseTxs(r, from, id)).some((x) => x.success), 90000, "a mined release");
  await sleep(3000);
  assert.ok(it, "the unknown release's identity was persisted"); assert.equal(it.txs[0].nonce, seen.nonce);
  // fixed words only: the RPC's error text (which can name an endpoint and its key) never reaches the state file
  // (absent when the process died before the broadcast answered: persisted first, outcome unknown)
  assert.ok([undefined, "unconfirmed"].includes(it.txs[0].broadcast), `broadcast: ${it.txs[0].broadcast}`);
  assert.ok(!fs.readFileSync(h1.stateFile, "utf8").includes("test proxy"), "no RPC error text in the state file");
  assert.equal(await r.pc.getTransaction({ hash: it.txs[0].hash }).catch(() => null), null, "the chain never saw it");
  assert.match(h2.stdout(), /\[release\] restored 1 unresolved release/);
  const rel = await releaseTxs(r, from, id);
  assert.equal(rel.length, 1, "exactly one release mined"); assert.notEqual(rel[0].hash, it.txs[0].hash);
  assert.ok(rel[0].nonce > it.txs[0].nonce, "the unknown one's nonce was consumed before a new release was signed");
  const ev = await ledgerEvents(r, from, id);
  const relBlock = ev.find((e) => e.eventName === "Released").blockNumber;
  assert.ok(relBlock > 0n);
  assert.deepEqual(await launchesWithoutNewLease(r, h2, from, id, t0), [], "every launch ran under a lease claimed after the release");
  const resumedBefore = /resuming our own live lease/.test(h2.stdout().slice(0, h2.stdout().indexOf(`[release] ${id} released`)));
  assert.equal(resumedBefore, false, "never resumed while the unknown release was unresolved");
  await retire(r, id);
  t.diagnostic(`nonce ${it.txs[0].nonce} consumed by ${/fenced by/.test(h2.stdout()) ? "the fence" : "another operator transaction"}; release ${rel[0].hash}`);
});
