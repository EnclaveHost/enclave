// The ACTUAL supervisor.js's lease release under the conditions the move review found unsafe
// (work/claude-move-review-result.md; the fix: work/independent-move-fix-interface.txt). Real claim loop (registration,
// a loopback attestation document whose format names SEV-SNP, CLAIM_POLL_SEC 2, MOVE_HOLDOFF_SEC 30), real ledger and
// schema-4 registry on anvil, a stub app manager whose launches are counted. Each case would hand an app a lease its own
// release ends (or report a release that did not happen) on the pre-fix code; MOVE_TEST_SUPERVISOR=<file> runs the same
// cases against another supervisor file (the negative control).
//   A  mining stalls past the stand-down       B  "latest" reads lag (a load-balanced RPC)
//   D  a release the network never saw          E  release/delete during an owner restart
//   F  a lease held by another host of the SAME operator
// Restart and recovery of a pending release: test/move-release-restart.test.mjs.
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keccak256, toBytes, createPublicClient, http as viemHttp } from "viem";
import { haveTools, startRig, startActualHost, KEYS } from "./helpers/cli-independent-rig.mjs";
import { TOKEN, RELEASE_SELECTOR, sleep, ownerAddress, operatorAddress, newLease, servableAppRef, getRow, login, api, startProxy,
  releaseTxs, ledgerEvents, pendingFrom, launchesWithoutNewLease, launchesOf, retire, claimLog } from "./helpers/move-release-rig.mjs";

const SUPERVISOR = process.env.MOVE_TEST_SUPERVISOR || "supervisor.js";
const skip = haveTools();
const T = skip ? { skip, timeout: 200000 } : { timeout: 200000 };
let r, tmp, appRef;
const dirFor = (n) => fs.mkdtempSync(path.join(tmp, n + "-"));
const codeOf = (x) => x.json && (x.json.code || x.json.error);

before(async () => {
  if (skip) return;
  r = await startRig();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "move-release-"));
  appRef = await servableAppRef(r);
});
after(async () => { if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
// one supervisor at a time: every case's host is the same runner and operator, so a survivor would claim the next case's
// deployment (and the memory budget holds one)
const live = [];
afterEach(async () => { for (const h of live.splice(0)) await h.kill(); await r.setMining(true); });

async function host(id, leaseUntil, opts = {}) {
  const h = await startActualHost(r, { id, owner: ownerAddress, dir: dirFor("h"), token: TOKEN, leaseUntil, appRef, script: SUPERVISOR,
    env: { RELEASE_POLL_MS: "500", ...(opts.env || {}) }, ...opts });
  live.push(h);
  if (opts.claim) { await h.waitLog(/\[registry\] registered/, 30000); await h.waitLog(/\[ledger\] full pass/, 30000); }
  return h;
}

test("A: mining stalls past the stand-down: no resume onto the lease its release may still end; 200 only on the mined receipt; the stand-down runs from resolution", T, async () => {
  const { id, leaseUntil } = await newLease(r);
  const h = await host(id, leaseUntil, { claim: true });
  const tok = await login(h);
  const from = await r.pc.getBlockNumber();
  const l0 = launchesOf(h, id);
  await r.setMining(false);
  let answered = null;
  const reqP = api(h, "POST", `/v1/deployments/${id}/release`, tok).then((x) => (answered = x));
  // 40 s: past the 30 s stand-down, ~20 claim passes; the release is unmined, so the ledger still names this host
  await sleep(40000);
  assert.equal(answered, null, "no answer while the release is unmined");
  assert.equal(launchesOf(h, id), l0, "the app was not relaunched onto a lease its own release may still end" + claimLog(h));
  assert.equal((await getRow(r, id)).runner.toLowerCase(), r.runner.toLowerCase(), "the ledger still names this host");
  const pend = (await pendingFrom(r, operatorAddress)).filter((t) => t.input.startsWith(RELEASE_SELECTOR));
  assert.equal(pend.length, 1, "exactly one release in the mempool");
  // while it is unresolved: a second release and a restart are refused before any effect
  const again = await api(h, "POST", `/v1/deployments/${id}/release`, tok);
  assert.equal(again.status, 409); assert.equal(codeOf(again), "release_in_progress");
  assert.equal(again.json.release?.transactions?.[0]?.hash, pend[0].hash, "the refusal names the unresolved transaction");
  const rs = await api(h, "POST", `/v1/deployments/${id}/restart`, tok);
  assert.equal(rs.status, 409); assert.equal(codeOf(rs), "release_in_progress");
  await r.setMining(true);
  const x = await reqP;
  const resolvedAt = Date.now();
  assert.equal(x.status, 200, JSON.stringify(x.json)); assert.equal(x.json.released, true);
  const rel = await releaseTxs(r, from, id);
  assert.equal(rel.length, 1, "one release mined"); assert.equal(rel[0].hash, x.json.txHash); assert.ok(rel[0].success);
  assert.match(h.stdout(), new RegExp(`sweep skips ${id}: a release of this deployment from this host is unresolved \\(transaction ${pend[0].hash}`),
    "the claim loop saw the lease and stood aside because of the unresolved release");
  // nobody else takes it: after the stand-down, counted from RESOLUTION, this host claims it back with a NEW lease
  await h.waitLog(new RegExp(`\\[claim\\] ${id} adopted`), 90000, h.stdout().length);
  assert.ok(Date.now() - resolvedAt >= 28000, "the stand-down ran from resolution, not from the request");
  const ev = await ledgerEvents(r, from, id);
  const released = ev.find((e) => e.eventName === "Released");
  assert.ok(ev.some((e) => e.eventName === "Claimed" && e.blockNumber > released.blockNumber && e.args.enclaveId.toLowerCase() === r.runner.toLowerCase()),
    "relaunched only under a lease claimed after the release");
  assert.equal(launchesOf(h, id), l0 + 1);
  await retire(r, id);
});

test("B: \"latest\" ledger reads lag behind the release: no false failure, no blind retry, no resume onto the released lease", T, async () => {
  const proxy = await startProxy(r);
  const { id, leaseUntil } = await newLease(r);
  const h = await host(id, leaseUntil, { claim: true, rpc: proxy.url });
  const tok = await login(h);
  const from = await r.pc.getBlockNumber();
  proxy.mode.staleLatest = Number(from);   // every "latest" eth_call now answers as of before the release
  const t0 = Date.now();
  const x = await api(h, "POST", `/v1/deployments/${id}/release`, tok);
  assert.equal(x.status, 200, JSON.stringify(x.json)); assert.equal(x.json.released, true, "the receipt decides, not a lagging read");
  // 40 s past the 30 s stand-down: the sweep's "latest" ledger page still shows this host's live lease the whole time
  await sleep(40000);
  const rel = await releaseTxs(r, from, id);
  assert.equal(rel.length, 1, "no blind retry"); assert.equal(rel[0].hash, x.json.txHash);
  assert.deepEqual(await launchesWithoutNewLease(r, h, from, id, t0), [], "never relaunched on the stale view of its released lease" + claimLog(h));
  // the lag was real: through the supervisor's RPC the row still shows this host's lease, and its sweep acted on that view
  const viaProxy = await createPublicClient({ transport: viemHttp(proxy.url) }).readContract({ address: r.addresses.ledger, abi: r.A.ledger.abi,
    functionName: "get", args: [id] });
  assert.equal(viaProxy.runner.toLowerCase(), r.runner.toLowerCase(), "the proxy serves the pre-release row at latest");
  assert.match(h.stdout(), new RegExp(`own lease not yet resumed \\(${id}`), "the sweep saw its own (stale) live lease");
  proxy.mode.staleLatest = null;
  await retire(r, id);
});

test("D: a release the network never saw: one unresolved release at a time, its nonce consumed before a second is signed, 200 on the second's receipt", T, async () => {
  const proxy = await startProxy(r);
  const { id, leaseUntil } = await newLease(r);
  const h = await host(id, leaseUntil, { claim: true, rpc: proxy.url, env: { RELEASE_FENCE_SEC: "8", RELEASE_RETRY_SEC: "1" } });
  const tok = await login(h);
  const from = await r.pc.getBlockNumber();
  proxy.mode.swallowRelease = true;
  const x = await api(h, "POST", `/v1/deployments/${id}/release`, tok);
  assert.equal(new Set(proxy.swallowed.map((x) => x.nonce)).size, 1, "only the first release (and any re-broadcast of it) was dropped");
  assert.equal(x.status, 200, JSON.stringify(x.json)); assert.equal(x.json.released, true);
  const signed = [...h.stdout().matchAll(new RegExp(`\\[release\\] ${id} release (\\d)/4 signed (0x[0-9a-f]{64}) nonce (\\d+)`, "g"))];
  assert.equal(signed.length, 2, "exactly two releases signed");
  const [first, second] = signed.map((m) => ({ hash: m[2], nonce: Number(m[3]) }));
  assert.equal(await r.pc.getTransaction({ hash: first.hash }).catch(() => null), null, "the swallowed release does not exist on chain");
  assert.ok(second.nonce > first.nonce, "the second was signed only after the first one's nonce was consumed");
  assert.ok(await r.pc.getTransactionCount({ address: operatorAddress, blockTag: "latest" }) > first.nonce);
  const rel = await releaseTxs(r, from, id);
  assert.equal(rel.length, 1); assert.equal(rel[0].hash, second.hash); assert.equal(x.json.txHash, second.hash);
  await retire(r, id);
});

test("E: a release or delete during an owner restart is refused before any effect; the restart completes; the release works after", T, async () => {
  const { id, leaseUntil } = await newLease(r);
  const h = await host(id, leaseUntil);
  const tok = await login(h);
  const from = await r.pc.getBlockNumber();
  h.mode.deleteDelayMs = 3000;            // the restart is mid-flight for ~3 s (its DELETE, then the relaunch)
  const rsP = api(h, "POST", `/v1/deployments/${id}/restart`, tok);
  await sleep(500);
  const x = await api(h, "POST", `/v1/deployments/${id}/release`, tok);
  assert.equal(x.status, 409, JSON.stringify(x.json)); assert.equal(codeOf(x), "release_blocked"); assert.match(x.json.message, /restart/);
  const d = await api(h, "DELETE", `/v1/deployments/${id}`, tok);
  assert.equal(d.status, 409, JSON.stringify(d.json)); assert.equal(codeOf(d), "release_blocked");
  const rs = await rsP;
  h.mode.deleteDelayMs = 0;
  assert.equal(rs.status, 200, JSON.stringify(rs.json)); assert.equal(rs.json.status, "running");
  assert.equal((await releaseTxs(r, from, id)).length, 0, "nothing was released during the restart");
  assert.equal(h.effects.filter((e) => e.delete).length, 1, "only the restart's own stop");
  assert.equal((await getRow(r, id)).runner.toLowerCase(), r.runner.toLowerCase());
  const y = await api(h, "POST", `/v1/deployments/${id}/release`, tok);
  assert.equal(y.status, 200, JSON.stringify(y.json)); assert.equal(y.json.released, true);
  await retire(r, id);
});

test("F: a lease held by ANOTHER host of the same operator is not this host's: not_releasable, nothing stopped, nothing sent", T, async () => {
  const SIB_ENDPOINT = "https://sibling.independent.test", SIB = keccak256(toBytes(SIB_ENDPOINT));
  await r.write(r.wc(KEYS.operator), r.addresses.registry, r.A.registry4.abi, "register", [SIB_ENDPOINT, "independent/host", "0x" + "00".repeat(32),
    1000n, 0n, "0x0000000000000000000000000000000000000000"]);
  const { id, leaseUntil } = await newLease(r, { runner: SIB });
  // this host still holds a stale local record of it (it ran it once); the lease is the sibling's, under the SAME operator key
  const h = await host(id, leaseUntil);
  const tok = await login(h);
  const from = await r.pc.getBlockNumber();
  const x = await api(h, "POST", `/v1/deployments/${id}/release`, tok);
  assert.equal(x.status, 409, JSON.stringify(x.json)); assert.equal(codeOf(x), "not_releasable");
  assert.match(x.json.message, new RegExp(`runner ${SIB}`));
  assert.equal(h.effects.filter((e) => e.delete).length, 0, "nothing was stopped");
  assert.equal((await releaseTxs(r, from, id)).length, 0, "nothing was sent");
  assert.equal((await getRow(r, id)).runner.toLowerCase(), SIB.toLowerCase(), "the sibling's lease stands");
  await retire(r, id);
});
