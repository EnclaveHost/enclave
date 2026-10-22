// NEGATIVE CONTROL (not part of the patch). Test 2 of test/lease17-release.test.mjs (an IDENTICAL leaseUntil re-claim
// by this key on the rev-17 candidate ledger) run against the PRE-CHANGE supervisor (MOVE_TEST_SUPERVISOR =
// base/supervisor.js). Expected: the restored generation-1 intent cannot tell generation 2 apart (runner, operator and
// leaseUntil are identical), so it re-sends release(id) and ENDS generation 2. The candidate supervisor passes test 2,
// so the generation check in the candidate is what prevents this.
// Run from work/cli-final-parity/tree (helpers and node_modules resolve there).
import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const H = path.resolve(process.cwd(), "test/helpers");
const { haveTools, startRig, startActualHost, KEYS } = await import(path.join(H, "cli-independent-rig.mjs"));
const { TOKEN, sleep, ownerAddress, newLease, servableAppRef, getRow, login, api, startProxy, anyReleaseTxs, leaseOf, waitFor, claimLog, retire } =
  await import(path.join(H, "move-release-rig.mjs"));

const SUPERVISOR = process.env.MOVE_TEST_SUPERVISOR;
const skip = haveTools() || (!SUPERVISOR && "set MOVE_TEST_SUPERVISOR to the pre-change supervisor");
const T = skip ? { skip, timeout: 240000 } : { timeout: 240000 };
let r, tmp, appRef;
const live = [];
before(async () => { if (skip) return; r = await startRig({ ledgerRev: 17 }); tmp = fs.mkdtempSync(path.join(os.tmpdir(), "l17ctl-")); appRef = await servableAppRef(r); });
after(async () => { if (r) await r.stop(); if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });
afterEach(async () => { for (const h of live.splice(0)) await h.kill(); });

test("CONTROL: the pre-change supervisor re-sends the generation-1 release against generation 2 at an identical leaseUntil", T, async () => {
  const { id } = await newLease(r, { fund: 50_000n });
  const l1 = await leaseOf(r, id);
  const proxy = await startProxy(r);
  const dir = fs.mkdtempSync(path.join(tmp, "h-"));
  const h1 = await startActualHost(r, { id, owner: ownerAddress, dir, token: TOKEN, leaseUntil: l1[2], appRef, script: SUPERVISOR, rpc: proxy.url,
    env: { RELEASE_POLL_MS: "500", RELEASE_RETRY_SEC: "1" } });
  live.push(h1);
  const tok = await login(h1);
  proxy.mode.swallowRelease = true;
  api(h1, "POST", `/v1/deployments/${id}/release`, tok).catch(() => {});
  await waitFor(() => proxy.swallowed[0] || null, 30000, "the swallowed release");
  await sleep(2500);
  await h1.kill();
  const it = JSON.parse(fs.readFileSync(h1.stateFile, "utf8")).releaseIntents.find((i) => i.id === id);
  assert.ok(it && it.txs[0], "intent persisted");
  assert.equal(it.generation, undefined, "the pre-change supervisor records no generation");
  const hash = await r.wc(KEYS.operator).writeContract({ address: r.addresses.ledger, abi: r.A.ledger.abi, functionName: "releaseLease", args: [id, r.runner, 1n], gas: 2_000_000n });
  await r.pc.waitForTransactionReceipt({ hash });
  await r.write(r.wc(KEYS.operator), r.addresses.ledger, r.A.ledger.abi, "claim", [id, r.runner]);
  const l2 = await leaseOf(r, id);
  assert.deepEqual([l2[2], l2[3]], [l1[2], 2n], "generation 2 at the IDENTICAL leaseUntil");
  const from = await r.pc.getBlockNumber({ cacheTime: 0 });
  const h2 = await startActualHost(r, { id, owner: ownerAddress, dir, token: TOKEN, leaseUntil: l2[2], appRef, script: SUPERVISOR, stateFile: h1.stateFile, seed: false,
    env: { RELEASE_POLL_MS: "500", RELEASE_RETRY_SEC: "1" } });
  live.push(h2);
  const sent = await waitFor(async () => { const t = await anyReleaseTxs(r, from, { id }); return t.length ? t : null; }, 60000, "a re-sent release" + claimLog(h2));
  const l3 = await leaseOf(r, id);
  console.log("CONTROL OBSERVED", JSON.stringify({ sent: sent.map((t) => ({ kind: t.kind, block: t.block, success: t.success })), after: { runner: l3[0], generation: String(l3[3]) } }));
  assert.equal(sent[0].kind, "release", "the pre-change supervisor re-sent an UNNAMED release(id)");
  assert.equal(sent[0].success, true);
  assert.match(l3[0], /^0x0{64}$/, "and it ENDED generation 2 (the lease this key re-claimed)");
  await retire(r, id);
});
