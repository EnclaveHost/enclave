// Focused browserless regression tests for the EnclaveDNS release page (app.js) while a MetaMask request is unresolved.
// The REAL handoff server.mjs runs on the reviewed in-memory Base model (enclavedns-stale-20261021/wallet-handoff/test/harness.mjs;
// journals in a temp dir; no RPC, no network but loopback). app.js runs in a vm "page" with a mocked EIP-1193 provider.
// Scenarios run against the CURRENT page (app.orig.js = the locked 2ccf3512) to show the defect, and the FIXED app.js.
// Every page is stopped (awaited, deterministic) before its server closes; the runner must exit on its own.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handoff, doUpload } from "../../enclavedns-stale-20261021/wallet-handoff/test/harness.mjs";
import { page, until } from "./page.mjs";
const here = path.dirname(fileURLToPath(import.meta.url));
const ORIG = path.join(here, "../app.orig.js"), FIXED = path.join(here, "../app.js"), EARLY = path.join(here, "../app.early-candidate.js");
const row = (p, n) => p.els.ops.children[n - 1]?.children?.[4]?.textContent || "";
const FEE = /^Review step 2 in MetaMask: to 0x[0-9a-fA-F]{40}, value 0, maximum fee [0-9.]+ ETH\. Do not edit gas or fees/;

async function world({ released = false } = {}) {
  const h = await handoff(); await h.post("/start"); const up = await doUpload(h); assert.equal(up.status, 200);
  if (released) { const p = await h.post("/tx/prepare", { step: "publish" }); assert.equal(p.status, 200); const r = await h.post("/tx/release", { step: "publish" }); assert.equal(r.status, 200, JSON.stringify(r.body)); }
  return h;
}
async function open(h, src, opts = {}) {
  const p = page({ src, origin: h.origin, chainId: "0x" + h.t.chainId.toString(16), owner: h.t.admin, ...opts });
  await until(() => p.els.status.textContent !== "Loading…" && !p.els.connect.disabled, "page ready");
  return p;
}
async function startToWallet(p) { await p.click("connect"); await until(() => !p.els.start.disabled, "start enabled"); void p.click("start"); await until(() => p.sendTx, "eth_sendTransaction"); }
const publishOf = async (h) => (await h.state()).steps.find((s) => s.step === "publish");
async function closeAll(h, ...pages) { try { for (const p of pages) if (p) await p.stop(); } finally { await h.close(); await h.gw.close(); } }

test("observed state reproduced on the CURRENT page: released attempt, new request pending -> stale 'ready' row, recovery text with no Release, Start disabled", async () => {
  const h = await world({ released: true }); let p;
  try {
    p = await open(h, ORIG); await startToWallet(p);
    assert.equal((await publishOf(h)).status, "awaiting-wallet", "the server journaled request 2");
    assert.match(row(p, 2), /^ready/, "DEFECT: the page still shows the pre-prepare row");
    assert.equal(p.els.recovery.hidden, false); assert.match(p.els["recovery-text"].textContent, /unknown outcome/); assert.equal(p.els.release.hidden, true, "DEFECT: recovery text but no Release");
    assert.equal(p.els.start.disabled, true, "Start stuck while the wallet promise is unresolved");
  } finally { await closeAll(h, p); }
});

test("FIXED: honest released text; Start (no extra dialog) -> the server's truth, pending status with the fee review kept; no Release, no resend", async () => {
  const h = await world({ released: true }); let p;
  try {
    p = await open(h, FIXED);
    assert.match(p.els["recovery-text"].textContent, /was released after an unknown outcome.*same nonce 1141/); assert.equal(p.els.release.hidden, true);
    await startToWallet(p);
    assert.equal(p.confirms.length, 0, "the Start click is the user's intent: no confirmation dialog");
    assert.match(row(p, 2), /^awaiting-wallet/, "fresh row before the wallet call");
    assert.match(p.els["recovery-text"].textContent, /waiting for your decision in MetaMask \(opened \d\d:\d\d:\d\d UTC, nonce 1141\).*sends nothing again/);
    assert.match(p.els.status.textContent, FEE, "the fee review text is not erased by the refresh");
    assert.equal(p.els.release.hidden, true, "never offered for this page's own open request"); assert.equal(p.els.start.disabled, true);
    const tx = (await publishOf(h)).transaction;
    assert.deepEqual(p.sendTx.tx, tx, "exactly the server-prepared transaction reached the wallet");
    assert.equal(p.els.transaction.textContent, JSON.stringify(tx, null, 2));
    const before = p.posts.length; await p.click("start");
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(p.posts.length, before, "a second Start while pending posts nothing"); assert.match(p.els.status.textContent, FEE, "and leaves the fee text");
    assert.equal(p.calls.filter((c) => c === "eth_sendTransaction").length, 1, "one wallet request, no timeout retry");
  } finally { await closeAll(h, p); }
});

test("FIXED: a prepared request that expired before reaching MetaMask leaves no pending state: Release offered, nothing sent (early candidate leaked it)", async () => {
  for (const [src, leak] of [[FIXED, false], [EARLY, true]]) {
    const h = await world(); let p;
    try {
      p = await open(h, src, { skewMs: 24 * 3600e3 });
      await p.click("connect"); await until(() => !p.els.start.disabled, "start"); await p.click("start");
      // run() shows the expiry error, then its load() lets the server's 'blocked' text replace it (unchanged original behaviour)
      assert.equal(p.els.status.textContent, "step publish has an open attempt (awaiting-wallet); resolve it first"); assert.equal(p.sendTx, null, "no wallet request");
      assert.equal(p.calls.includes("eth_sendTransaction"), false);
      assert.equal((await publishOf(h)).status, "awaiting-wallet");
      assert.equal(p.els.release.hidden, leak, leak ? "early candidate: pending leaked, Release hidden" : "Release offered for the unsent request");
      if (!leak) {
        assert.match(p.els["recovery-text"].textContent, /unknown outcome/);
        await p.click("release"); assert.ok(p.posts.includes("/tx/release")); assert.equal((await publishOf(h)).status, "ready", "the chain-checked release works with one click");
      }
    } finally { await closeAll(h, p); }
  }
});

test("a LATE MetaMask success is still verified by the server (both pages)", async () => {
  for (const src of [ORIG, FIXED]) {
    const h = await world(); let p;
    try {
      p = await open(h, src); await startToWallet(p);
      const hash = h.model.land(p.sendTx.tx, {}); h.model.mine(2); p.sendTx.resolve(hash);
      await until(() => /^confirmed/.test(row(p, 2)), "publish confirmed", 15000);
      const s = await publishOf(h); assert.equal(s.status, "confirmed"); assert.equal(s.hash, hash.toLowerCase());
    } finally { await closeAll(h, p); }
  }
});

test("RELOAD restores Verify + Release from the server WITHOUT modifying it, and Start never resends (both pages)", async () => {
  for (const src of [ORIG, FIXED]) {
    const h = await world(); let a, b;
    try {
      a = await open(h, src); await startToWallet(a);
      const journal = JSON.stringify(h.journals.publish.read());
      await a.stop();                                                   // the first page is gone; its request stays open
      assert.equal(JSON.stringify(h.journals.publish.read()), journal, "closing the page changed nothing");
      b = await open(h, src);
      assert.equal(b.els.recovery.hidden, false); assert.equal(b.els.release.hidden, false, "Release offered after reload"); assert.match(b.els["recovery-text"].textContent, /unknown outcome/);
      await b.click("connect"); await until(() => !b.els.start.disabled, "start"); await b.click("start");
      assert.equal(b.posts.length, 0, "no POST at all: no /tx/prepare resend"); assert.equal(b.sendTx, null, "no wallet request");
      assert.equal(JSON.stringify(h.journals.publish.read()), journal, "the server journal is untouched");
    } finally { await closeAll(h, a, b); }
  }
});

test("LIMIT (multi-tab, unchanged server): a late rejection of an older request resets the newer one on BOTH pages", async () => {
  // A single page cannot open request 2 while its request 1 is pending (Start stays disabled, Release is hidden). With TWO
  // tabs (or a reload while MetaMask still shows request 1) /tx/rejected cannot tell attempts apart. Documented, not fixed.
  for (const src of [ORIG, FIXED]) {
    const h = await world(); let a;
    try {
      a = await open(h, src); await startToWallet(a);
      assert.equal((await h.post("/tx/release", { step: "publish" })).status, 200);   // elsewhere: guarded release, request 2
      h.model.state.baseFee *= 2n;
      const r2 = await h.post("/tx/prepare", { step: "publish" }); assert.equal(r2.status, 200); assert.notDeepEqual(r2.body.transaction, a.sendTx.tx);
      a.sendTx.reject(Object.assign(Error("User rejected the request."), { code: 4001 }));
      await until(() => /You rejected step 2/.test(a.els.status.textContent), "late answer handled");
      const s = await publishOf(h);
      assert.deepEqual({ status: s.status, rejectedPosted: a.posts.includes("/tx/rejected") }, { status: "ready", rejectedPosted: true });
      assert.equal(s.nonce, 1141, "the reserved nonce is kept: request 2, if MetaMask still sends it, and any retry share it, so only one can land");
    } finally { await closeAll(h, a); }
  }
});

test("FIXED: a rejection of THIS page's own open request resets it exactly as before", async () => {
  const h = await world(); let p;
  try {
    p = await open(h, FIXED); await startToWallet(p); p.sendTx.reject(Object.assign(Error("rejected"), { code: 4001 }));
    await until(() => /You rejected step 2/.test(p.els.status.textContent), "rejected");
    assert.ok(p.posts.includes("/tx/rejected")); assert.equal((await publishOf(h)).status, "ready"); assert.equal(p.els.start.disabled, false);
  } finally { await closeAll(h, p); }
});
