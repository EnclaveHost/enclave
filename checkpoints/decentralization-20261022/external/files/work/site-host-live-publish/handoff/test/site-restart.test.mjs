// Finding 1: stage-B readiness is process-local. A restarted process re-verifies the confirmed Created binding and opens
// its own reviewed stage-B listener over the same disk journals; a submitted reserve attempt survives and is never
// duplicated; a listener failure after create is retried without any new signature, upload or transaction.
// In-memory Base model (deployed ABIs), injected wallet and gateway, disk journals; nothing but loopback is touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fixture, hit, launch, signUpload, sendStep, fileJournals, gc, upload } from "./site-harness.mjs";

test.afterEach(() => gc());   // each upload holds the 46 MB artifact: free it before the next test (site-harness.mjs)

const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const listening = (url) => fetch(url + "/queue").then(() => true, () => false);

/** Steps 1-3 through the site server; returns the create hash. */
async function throughCreate(h, fx) {
  assert.equal((await hit(h.origin, "/start", { token: h.token })).status, 200);
  assert.equal((await signUpload(h)).res.status, 200);
  assert.equal((await sendStep(h, fx, "publish")).res.json.verification.outcome, "confirmed");
  const cr = await sendStep(h, fx, "create");
  assert.equal(cr.res.status, 200); assert.equal(cr.res.json.verification.deploymentId, fx.t.predictedId.toLowerCase());
  return cr;
}

test("restart after create: a new process re-verifies the Created binding, serves stage B on its own listener, keeps the submitted deposit attempt and never duplicates it", async () => {
  const fx = fixture(), siteDir = tmpDir("site-j-"), sbDir = tmpDir("site-sb-");
  let h = await launch(fx, { journals: fileJournals(siteDir), tmp: sbDir });
  let depositHash, firstUrl;
  try {
    await throughCreate(h, fx);
    firstUrl = h.stageB.url; assert.ok(firstUrl);
    const q = await (await fetch(firstUrl + "/queue")).json();
    const bh = (p, body) => hit(firstUrl, p, { token: q.token, body });
    assert.equal((await bh("/start")).status, 200);
    const p = await bh("/prepare", { index: 0 }); assert.equal(p.status, 200, JSON.stringify(p.json));
    depositHash = fx.model.land(p.json.transaction);                 // MetaMask sent the deposit ...
  } finally { await h.close(); }                                     // ... and both servers died before its result
  assert.equal(await listening(firstUrl), false, "the first process's stage-B listener is gone");
  const journaled = JSON.parse(fs.readFileSync(path.join(siteDir, "session.json"), "utf8"));
  assert.equal(journaled.handover, firstUrl, "the journal records the handover (public record only)");
  const nonceAfterDeposit = fx.model.state.nonce;

  // a restart whose chain view does NOT confirm the journaled create opens nothing
  const createHash = JSON.parse(fs.readFileSync(path.join(siteDir, "create.json"), "utf8")).hash;
  const saved = fx.model.state.receipts[createHash]; delete fx.model.state.receipts[createHash];   // the providers lack its receipt
  h = await launch(fx, { journals: fileJournals(siteDir), tmp: sbDir });
  try {
    await assert.rejects(h.app.handover());
    const v = h.app.view();
    assert.equal(v.next, null); assert.equal(v.stageB.url, null, "a recorded URL is not readiness"); assert.equal(v.stageB.recorded, firstUrl);
    assert.ok(v.stageB.error); assert.equal(h.stageB.opened, 0, "no stage-B queue was opened");
  } finally { await h.close(); }
  fx.model.state.receipts[createHash] = saved;

  // the real restart: the entry point's path (app.handover() after load), called twice at once
  h = await launch(fx, { journals: fileJournals(siteDir), tmp: sbDir });
  try {
    assert.equal(h.app.view().stageB.url, null, "nothing serves before this process verified the binding");
    const [u1, u2] = await Promise.all([h.app.handover(), h.app.handover()]);
    assert.equal(u1, u2); assert.equal(h.stageB.opened, 1, "one listener for concurrent handovers");
    assert.equal(await h.app.handover(), u1, "idempotent");
    assert.equal((await hit(h.origin, "/state", { method: "GET" })).json.stageB.url, u1);
    const q = await (await fetch(u1 + "/queue")).json();                // the actual stage-B HTTP server of this process
    assert.equal(q.session, "started"); assert.equal(q.operations[0].status, "awaiting-wallet"); assert.equal(q.operations[1].status, "ready");
    const bh = (p, body) => hit(u1, p, { token: q.token, body });
    assert.equal((await bh("/prepare", { index: 0 })).status, 409, "no second deposit request while the first is open");
    assert.equal((await bh("/prepare", { index: 1 })).status, 409, "configure waits for the deposit");
    const r = await bh("/result", { index: 0, hash: depositHash }); assert.equal(r.json.verification.outcome, "confirmed");
    const c = await bh("/prepare", { index: 1 }); assert.equal(c.status, 200);
    assert.equal((await bh("/result", { index: 1, hash: fx.model.land(c.json.transaction) })).json.verification.outcome, "confirmed");
    assert.equal(fx.model.state.nonce, nonceAfterDeposit + 1, "after the restart only configure was sent");
    const res = Object.values(fx.model.state.res).find((x) => x.enabled);
    assert.equal(res.balanceWei, 1_000_000_000_000_000n, "exactly one 0.001 ETH deposit");
    assert.equal(fx.model.state.nonce, 44, "four transactions in all: publish, create, deposit, configure");
  } finally { await h.close(); }
});

test("a stage-B listener failure after create stays visible and is retried without re-signing, re-uploading or re-creating", async () => {
  const fx = fixture();
  const holder = http.createServer(); await new Promise((ok) => holder.listen(0, "127.0.0.1", ok));
  const port = holder.address().port;                                 // the stage-B port is taken
  const h = await launch(fx, { stageBPort: port });
  try {
    const cr = await throughCreate(h, fx);
    assert.equal(cr.res.json.stageB.url, null); assert.match(cr.res.json.stageB.error, /EADDRINUSE/);
    let v = (await hit(h.origin, "/state", { method: "GET" })).json;
    assert.equal(v.next, null); assert.equal(v.blocked, null); assert.equal(v.stageB.url, null); assert.match(v.stageB.error, /EADDRINUSE/);
    const again = await hit(h.origin, "/handover", { token: h.token });
    assert.equal(again.status, 409); assert.match(again.json.error, /did not start/);
    assert.equal((await hit(h.origin, "/handover", {})).status, 403, "the retry needs the per-launch token");
    await new Promise((ok) => holder.close(ok));                     // the port is free again
    const ok = await hit(h.origin, "/handover", { token: h.token });
    assert.equal(ok.status, 200); assert.equal(ok.json.url, `http://127.0.0.1:${port}`); assert.equal(ok.json.stageB.error, null);
    const q = await (await fetch(ok.json.url + "/queue")).json();
    assert.deepEqual(q.operations.map((o) => o.status), ["ready", "ready"]);
    v = (await hit(h.origin, "/state", { method: "GET" })).json;
    assert.equal(v.stageB.url, ok.json.url);
    assert.deepEqual([h.gw.seen.token, h.gw.seen.add, h.gw.seen.car], [1, 1, 1], "one upload authorization and upload only");
    assert.equal(fx.model.state.nonce, 42, "only publish and create were sent");
    assert.equal(h.app.state.create.attempts.length, 1, "create was never prepared again");
    assert.equal(h.stageB.opened, 3, "each attempt opened a fresh queue; the two failed ones were closed");
  } finally { await h.close(); if (holder.listening) await new Promise((ok) => holder.close(ok)); }
});
