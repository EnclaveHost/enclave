// The handoff end to end over loopback HTTP against the in-memory Base model: the full flow, ordering, fail-closed drift
// (incl. the SessionVault's owner, code and STAGING hold), nonce/replay, wallet alteration, revert, receipt depth, restart
// with a submitted or unanswered request, plan binding, upload refusals without secret leakage, and the transport checks.
// Adapted from the reviewed IPNS Publisher handoff test (3 steps; the upgrade goes through the vault).
//   run: node --test test/handoff.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { handoff, doUpload, doStep, readJournalDir, OTHER, TOKEN } from "./harness.mjs";
import { createPublisherServer } from "../server.mjs";

const lc = (a) => String(a).toLowerCase();

test("happy path: upload verified -> publish -> upgrade (vault ownerCall), each confirmed on two providers; exactly the plan's end state", async () => {
  const h = await handoff();
  try {
    assert.equal((await h.post("/start")).status, 200);
    const up = await doUpload(h);
    assert.equal(up.status, 200, JSON.stringify(up.body)); assert.equal(up.body.upload.status, "uploaded"); assert.equal(up.body.upload.cid, h.t.expectedCid);
    for (const k of ["publish", "upgrade"]) {
      const r = await doStep(h, k);
      assert.equal(r.prepared.status, 200, JSON.stringify(r.prepared.body)); assert.equal(r.prepared.body.transaction.value, "0x0");
      assert.equal(r.result.status, 200, JSON.stringify(r.result.body)); assert.equal(r.result.body.verification.outcome, "confirmed"); assert.equal(r.result.body.verification.providers, 2);
    }
    const s = h.model.state;
    assert.equal(s.versions.length, 6); assert.equal(s.versions[5].version, "0.1.5"); assert.equal(s.versions[5].cid, h.t.expectedCid); assert.equal(s.versions[5].approval, 1);
    assert.equal(s.versions[5].config, h.t.publish.config); assert.equal(s.app.name, h.t.app.name); assert.equal(s.app.description, h.t.app.description);
    assert.equal(s.dep.appRef, h.plan.appRefNext); assert.equal(s.dep.configCid, h.t.deployment.envelope);
    assert.equal(s.dep.owner, lc(h.t.vault.address), "the vault is still the deployment's owner");
    assert.deepEqual(s.vault.held, [1, h.t.vault.held.promoted, h.t.vault.held.createdBy], "still STAGING, not promoted");
    assert.equal(s.nonce, 1141 + 2, "exactly two transactions");
    const v = await h.state(); assert.equal(v.next, null); assert.equal(v.done, true);
    const j = readJournalDir(h.dir); assert.ok(!j.includes(TOKEN)); assert.ok(!j.includes(up.signature.slice(2, 60)));
    assert.equal((await h.post("/tx/prepare", { step: "upgrade" })).status, 409, "nothing more to send");
  } finally { await h.close(); await h.gw.close(); }
});

test("strict order: no transaction before the verified upload; upgrade only after publish CONFIRMED", async () => {
  const h = await handoff();
  try {
    await h.post("/start");
    assert.match((await h.post("/tx/prepare", { step: "publish" })).body.error, /upload is next/);
    await doUpload(h);
    assert.match((await h.post("/tx/prepare", { step: "upgrade" })).body.error, /publish is next/);
    assert.equal((await h.post("/tx/prepare", { step: "config" })).status, 400, "there is no config step");
    const p = await h.post("/tx/prepare", { step: "publish" });
    const hash = h.model.land(p.body.transaction, { extra: 0 });
    assert.equal((await h.post("/tx/result", { step: "publish", hash })).status, 400, "unconfirmed: verification refuses");
    assert.match((await h.post("/tx/prepare", { step: "upgrade" })).body.error, /open attempt/);
    h.model.mine(2);
    assert.equal((await h.post("/tx/result", { step: "publish", hash })).body.verification.outcome, "confirmed");
    assert.equal((await h.post("/tx/prepare", { step: "upgrade" })).status, 200);
  } finally { await h.close(); await h.gw.close(); }
});

test("fail closed on drift, re-checked right before each wallet request: index, v4, approval premise, app text, envelope, appRef, vault owner/code/hold, code, pending", async () => {
  const cases = [
    ["another version appeared (0.1.5 would not be index 5)", (s) => s.versions.push({ ...s.versions[4], version: "0.1.9" }), "publish", /lists 6 versions/],
    ["version 4's config changed", (s) => { s.versions[4].config = s.versions[4].config + " "; }, "publish", /version 4's config/],
    ["the catalog owner is not the publisher (no auto-approval)", (s) => { s.catalogOwner = "0x" + "77".repeat(20); }, "publish", /would land Pending/],
    ["the app description changed", (s) => { s.app.description = "x"; }, "publish", /description changed/],
    ["the deployment's envelope changed", (s) => { s.dep.configCid = "{}"; }, "publish", /public config envelope/],
    ["the deployment's version reference changed", (s) => { s.dep.appRef = s.dep.appRef.replace(/4$/, "3"); }, "publish", /version reference/],
    ["the deployment left the vault", (s) => { s.dep.owner = "0x" + "99".repeat(20); }, "publish", /not the pinned SessionVault/],
    ["the vault has another owner", (s) => { s.vault.owner = "0x" + "66".repeat(20); }, "publish", /SessionVault's owner is not the admin/],
    ["the vault was promoted to PROD", (s) => { s.vault.held = [2, "0x" + "12".repeat(32), s.vault.held[2]]; }, "publish", /no longer holds the deployment as STAGING/],
    ["the vault's code changed", (s, h) => { s.codes[lc(h.t.vault.address)] = "0x60ee"; }, "publish", /SessionVault runtime code/],
    ["the catalog code changed", (s, h) => { s.codes[lc(h.t.catalog)] = "0x60ff"; }, "publish", /runtime code/],
    ["a transaction from the owner is pending", (s) => { s.pendingExtra = 1; }, "publish", /pending/],
    ["the owner account has code (EIP-7702)", (s) => { s.adminCode = "0xef0100" + "11".repeat(20); }, "publish", /has code/],
  ];
  for (const [label, drift, step, want] of cases) {
    const h = await handoff();
    try {
      await h.post("/start"); await doUpload(h);
      drift(h.model.state, h);
      const r = await h.post("/tx/prepare", { step });
      assert.equal(r.status, 400, label); assert.match(r.body.error, want, label);
      assert.equal((await h.state()).steps.find((s) => s.step === step).status, "ready", `${label}: nothing reached the wallet`);
    } finally { await h.close(); await h.gw.close(); }
  }
  const h2 = await handoff();
  try {
    await h2.post("/start"); await doUpload(h2); await doStep(h2, "publish");
    h2.model.state.vault.owner = "0x" + "55".repeat(20);                    // drift between steps: the upgrade refuses before MetaMask
    assert.match((await h2.post("/tx/prepare", { step: "upgrade" })).body.error, /SessionVault's owner is not the admin/);
  } finally { await h2.close(); await h2.gw.close(); }
});

test("providers that disagree are refused at Start", async () => {
  const tweak = [null, (m, a, r) => (m === "readContract" && a[1] === "get" ? { ...r, leaseUntil: r.leaseUntil + 1n } : r)];
  const h = await handoff({ tweak });
  try {
    const s = await h.post("/start"); assert.equal(s.status, 400); assert.match(s.body.error, /providers disagree/);
  } finally { await h.close(); await h.gw.close(); }
});

test("nonce and replay: another step's hash is refused, a submitted hash is never replaced, nothing is accepted after confirmation", async () => {
  const h = await handoff();
  try {
    await h.post("/start"); await doUpload(h);
    const pub = await doStep(h, "publish");
    const up = await h.post("/tx/prepare", { step: "upgrade" });
    assert.equal(up.status, 200);
    assert.equal(up.body.transaction.nonce, "0x" + (1142).toString(16), "the next nonce");
    assert.equal(lc(up.body.transaction.to), lc(h.t.vault.address), "the upgrade goes to the vault");
    assert.match((await h.post("/tx/result", { step: "upgrade", hash: pub.hash })).body.error, /belongs to another step/);
    const hash = h.model.land(up.body.transaction, { extra: 0 });
    assert.equal((await h.post("/tx/result", { step: "upgrade", hash })).status, 400);
    assert.match((await h.post("/tx/result", { step: "upgrade", hash: "0x" + "ab".repeat(32) })).body.error, /different transaction already submitted/);
    h.model.mine(2);
    assert.equal((await h.post("/tx/result", { step: "upgrade", hash })).body.verification.outcome, "confirmed");
    for (const x of [hash, "0x" + "cd".repeat(32)]) assert.match((await h.post("/tx/result", { step: "upgrade", hash: x })).body.error, /no wallet request/);
    assert.equal(h.model.state.nonce, 1143);
  } finally { await h.close(); await h.gw.close(); }
});

test("a wallet-altered gas limit lands but halts for review; a reverted upgrade (vault ownership moved) halts too", async () => {
  const h = await handoff();
  try {
    await h.post("/start"); await doUpload(h);
    const r = await doStep(h, "publish", { mutate: (tx) => { tx.gas = "0x" + (BigInt(tx.gas) + 1n).toString(16); } });
    assert.equal(r.result.status, 409); assert.match(r.result.body.error, /changed the gas limit/);
    assert.match((await h.post("/tx/prepare", { step: "upgrade" })).body.error, /changed the gas limit/);
  } finally { await h.close(); await h.gw.close(); }
  const h2 = await handoff();
  try {
    await h2.post("/start"); await doUpload(h2); await doStep(h2, "publish");
    const up = await h2.post("/tx/prepare", { step: "upgrade" });
    h2.model.state.vault.owner = "0x" + "99".repeat(20);                    // ownership moves before it lands: ownerCall reverts
    const hash = h2.model.land(up.body.transaction);
    assert.equal((await h2.post("/tx/result", { step: "upgrade", hash })).body.verification.outcome, "reverted");
    assert.equal(h2.model.state.dep.appRef, h2.plan.appRefPrev, "nothing changed on chain");
    assert.match((await h2.state()).blocked, /reverted on chain; halted/);
  } finally { await h2.close(); await h2.gw.close(); }
});

test("a direct ledger.setAppRef (not through the vault) is never the upgrade: the receipt check refuses it", async () => {
  const h = await handoff();
  try {
    await h.post("/start"); await doUpload(h); await doStep(h, "publish");
    const up = await h.post("/tx/prepare", { step: "upgrade" });
    const hash = h.model.land(up.body.transaction, { mutate: (tx) => { tx.to = h.t.ledger; tx.data = h.plan.setAppRefData; } });   // reverts: the admin is not the deployment owner
    const r = await h.post("/tx/result", { step: "upgrade", hash });
    assert.notEqual(r.status, 200); assert.match(r.body.error, /not this step's request|wrong recipient/);
  } finally { await h.close(); await h.gw.close(); }
});

test("restart: an unanswered request survives, is released only while its nonce is unused, the retry reuses that nonce; a landed one verifies after restart", async () => {
  const h = await handoff();
  const dir = h.dir, model = h.model, gw = h.gw;
  await h.post("/start"); await doUpload(h);
  const first = await h.post("/tx/prepare", { step: "publish" });
  await h.close();
  const h2 = await handoff({ dir, model, gw });
  try {
    const st = (await h2.state()).steps.find((s) => s.step === "publish");
    assert.equal(st.status, "awaiting-wallet"); assert.deepEqual(st.transaction, first.body.transaction, "the exact request is still shown");
    assert.match((await h2.post("/tx/prepare", { step: "publish" })).body.error, /open attempt/);
    assert.equal((await h2.post("/tx/release", { step: "publish" })).status, 200, "nonce unused: released");
    const again = await h2.post("/tx/prepare", { step: "publish" });
    assert.equal(again.body.transaction.nonce, first.body.transaction.nonce, "the retry keeps the nonce: only one can land");
    const hash = model.land(again.body.transaction);
    await h2.close();
    const h3 = await handoff({ dir, model, gw });
    try {
      assert.match((await h3.post("/tx/release", { step: "publish" })).body.error, /was used/, "a used nonce is never released");
      assert.equal((await h3.post("/tx/result", { step: "publish", hash })).body.verification.outcome, "confirmed");
    } finally { await h3.close(); }
  } finally { await h2.close().catch(() => {}); await gw.close(); }
});

test("only an explicit wallet 4001 resets an attempt; journals of another plan refuse to load", async () => {
  const h = await handoff();
  try {
    await h.post("/start"); await doUpload(h);
    const { body: { attemptId } } = await h.post("/tx/prepare", { step: "publish" });
    assert.equal((await h.post("/tx/rejected", { step: "publish", code: 4100, attemptId })).status, 409);
    assert.equal((await h.post("/tx/rejected", { step: "publish", code: 4001, attemptId })).status, 200);
    assert.equal((await h.state()).steps.find((s) => s.step === "publish").status, "ready");
    const journals = Object.fromEntries(["session", "upload", "publish", "upgrade"].map((k) => [k, { read: () => JSON.parse(fs.readFileSync(path.join(h.dir, `${k}.json`), "utf8")), write() {} }]));
    assert.throws(() => createPublisherServer({ t: h.t, plan: h.plan, planSha256: "f".repeat(64), journals }), /belongs to another plan/);
  } finally { await h.close(); await h.gw.close(); }
});

test("upload refusals: a signature by anyone but the owner, a wrong CID, a tampered CAR; nothing secret reaches the page or the journal", async () => {
  for (const [mode, key, want] of [["honest", OTHER, /not the admin's/], ["wrong-cid", undefined, /CID other than/], ["bad-car", undefined, /does not hash to its CID|CAR/]]) {
    const h = await handoff({ mode });
    try {
      await h.post("/start");
      const r = await doUpload(h, key);
      assert.equal(r.status, 409, mode); assert.match(r.body.error, want, mode);
      assert.equal((await h.state()).upload.status, "ready", mode);
      for (const text of [JSON.stringify(r.body), readJournalDir(h.dir)]) { assert.ok(!text.includes(TOKEN), mode); assert.ok(!text.includes(r.signature.slice(2, 60)), mode); }
      assert.ok(!h.gw.hits.some((x) => x.url === "/add-wasm") || mode !== "honest", "a foreign signature never reaches the gateway");
    } finally { await h.close(); await h.gw.close(); }
  }
});

test("transport: loopback origin + Host + launch token; cross-site refused; no route signs or accepts a transaction", async () => {
  const h = await handoff();
  try {
    const u = new URL(h.origin);
    const raw = (p, headers, method = "POST") => new Promise((ok) => { const r = http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (res) => { res.resume(); res.on("end", () => ok(res.statusCode)); }); r.end("{}"); });
    assert.equal(await raw("/start", { host: "evil.example:" + u.port, origin: h.origin, "x-signing-token": h.token }), 403, "foreign Host (DNS rebinding)");
    assert.equal((await h.post("/start", {}, { origin: "http://127.0.0.1:1" })).status, 403, "foreign Origin");
    assert.equal((await h.post("/start", {}, { "x-signing-token": "x" })).status, 403, "wrong token");
    assert.equal((await h.post("/start", {}, { "sec-fetch-site": "cross-site" })).status, 403, "cross-site");
    for (const p of ["/sign", "/send", "/tx/send", "/eth_sendTransaction"]) assert.equal((await h.post(p)).status, 404, p);
    const r = await fetch(h.origin + "/state"); assert.match(r.headers.get("content-security-policy"), /default-src 'none'/); assert.equal(r.headers.get("cache-control"), "no-store");
  } finally { await h.close(); await h.gw.close(); }
});
