// AUTHORED, NOT RUN. Static checks: the rendered slot markup per state (string-level, no DOM), and that the actual
// /sessions page wires the slot into the held card without disturbing its other controls (source text). Root's
// bounded browser DOM test uses held-card.fixture.html.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { slotHtml, releaseSlot, usdc6 } from "../../site/js/core/wallet-release-view.js";

const W = "0x0b2d009c0c9af05b12100d77f3c815fea822ee61", V = "0xb794c4dd0e1c5e6b72281799f282bfde7654345d";
const ID = "0xcab8fb59882d976bf4005448701149d734b0dab536d9bf46f2b5159b0b0819e9";
const review = { deployment: ID, vault: V, destination: W, ledger: "0xb1783b61e1fdee6a6163dc3cdac27bf32e7d117b", block: { number: "1", hash: "0x" + "aa".repeat(32) },
  appRef: "catalog://0x85/0", configCid: "", isPublic: true, ports: "http:8000", resources: {}, balance6: "9500000", spent6: "0", rate: "1", cap: "1",
  fee: { recipient: "0x" + "0".repeat(40), rate6: "0" }, env: 2, promoted: "0x01", delegationGranted: false, authorityBefore: "before", authorityAfter: "after",
  signature: "One EIP-712 \"Release\" signature", sessionAccess: "does not widen session access" };
const btn = (html, cls) => (html.match(new RegExp("<button[^>]*class=\"[^\"]*" + cls + "[^\"]*\"[^>]*>", "g")) || []);

test("checking/blocked: Move to wallet present but disabled, status is announced", () => {
  for (const st of [{ kind: "checking" }, { kind: "blocked", blockers: [{ code: "staging", text: "It is STAGING" }] }]){
    const h = slotHtml(ID, W, st);
    const b = btn(h, "wr-move");
    assert.equal(b.length, 1); assert.match(b[0], /disabled aria-disabled="true"/);
    assert.match(h, /role="status" aria-live="polite"/);
    assert.match(h, new RegExp(W));
    assert.doesNotMatch(h, /<input/);
  }
});

test("blocker text and codes are escaped", () => {
  const h = slotHtml(ID, W, { kind: "blocked", blockers: [{ code: "x\"><script>", text: "<img src=x onerror=alert(1)>" }] });
  assert.doesNotMatch(h, /<script>|<img/);
  assert.match(h, /&lt;img src=x/);
});

test("eligible -> enabled; review shows full id, vault, fixed destination, preserved balance, signature, no widening", () => {
  assert.doesNotMatch(btn(slotHtml(ID, W, { kind: "eligible", review }), "wr-move")[0], /disabled/);
  const h = slotHtml(ID, W, { kind: "review", review });
  for (const s of [ID, V, W, "9.500000 USDC", "Release", "does not widen session access", "Not atomic"]) assert.ok(h.includes(s), s);
  assert.equal(btn(h, "wr-sign").length, 1); assert.equal(btn(h, "wr-cancel").length, 1);
  assert.doesNotMatch(h, /<input|contenteditable/);
  assert.equal(usdc6("9500000"), "9.500000 USDC");
});

test("journal states: pending/uncertain offer only a read-only re-check; finalized offers nothing", () => {
  for (const state of ["intent", "signed", "dispatching", "uncertain", "submitted", "included", "conflict"]){
    const h = slotHtml(ID, W, { kind: "journal", record: { state, nonce: "0x" + "ab".repeat(32), deadline: "1" } });
    assert.equal(btn(h, "wr-move").length, 0, state); assert.equal(btn(h, "wr-sign").length, 0, state);
    assert.equal(btn(h, "wr-recheck").length, 1, state);
  }
  const f = slotHtml(ID, W, { kind: "journal", record: { state: "finalized", nonce: "0x", deadline: "1", txHash: "0x" + "cd".repeat(32), block: "9" } });
  assert.equal((f.match(/<button/g) || []).length, 0);
  assert.match(f, /Moved to your wallet/);
  assert.match(slotHtml(ID, W, { kind: "signing", review }), /aria-busy="true"/);
});

test("the actual /sessions page wires the slot into the held card and keeps every other control", () => {
  const src = readFileSync(new URL("../../site/js/pages/sessions.js", import.meta.url), "utf8");
  assert.match(src, /import \{ releaseSlot, startWalletRelease \} from "\.\.\/core\/wallet-release-view\.js"/);
  const held = src.slice(src.indexOf("function heldCard"), src.indexOf("function wire("));
  assert.match(held, /ss-promote/); assert.match(held, /releaseSlot\(h\)/);
  for (const id of ["ssWithdraw", "ssRevoke", "ssDelegGrant", "ssDelegRevoke", "ss-topup", "ss-extend", "ss-term", "ss-log-btn", '"[data-dep] .ss-promote"'])
    assert.ok(src.includes(id), id);
  assert.match(src, /wire\(body, info, S, rows, free\);[\s\S]{0,400}startWalletRelease\(/);
  assert.match(releaseSlot({ id: ID }), new RegExp('data-wr-dep="' + ID + '"'));
  assert.doesNotMatch(src, /ownerOp\(\{ op: "release"/, "release never goes through the unguarded core ownerOp");
});
