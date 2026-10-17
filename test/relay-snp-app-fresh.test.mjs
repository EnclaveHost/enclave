// relay/snp-app-fresh.mjs: ONE confidential-server app guest's fresh report over a caller's nonce, asked of the app's own
// public origin (<id8>.<app domain>/.well-known/enclave-attestation) with the key that origin presented. The relay drops an
// answer over another nonce, keeps page reports rare (one app check per box at a time, one per app per gap, no retry), passes
// a busy guest on as busy, says so when the app has no public address, and serves only a public deployment leased to the box.
//   run: node --test test/relay-snp-app-fresh.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSnpAppFresh, appOrigin, ATTEST_PATH } from "../relay/snp-app-fresh.mjs";

const HOST = { name: "metal0", mode: "snp", id: "0x" + "aa".repeat(32) };
const DEP = "0x9eb4e600" + "d1".repeat(28);
const lease = (at) => Math.floor(at / 1000) + 3600;

function world({ answer, rows } = {}) {
  const asked = []; let clock = 1_000_000;
  rows = rows || { [DEP]: { id: DEP, active: true, isPublic: true, runner: HOST.id, leaseUntil: lease(clock) } };
  const fresh = createSnpAppFresh({ appDomain: "app.enclave.host", confirmRow: async (id) => rows[id] || null, appGapMs: 30000, now: () => clock,
    fetchOrigin: async (host, nonceHex) => { asked.push([host, nonceHex]); return answer(nonceHex); } });
  return { fresh, asked, tick: (ms) => { clock += ms; }, rows };
}
const good = (n) => ({ status: 200, handshakeSpki: "MFkw", doc: { format: "sev-snp-guest-domain-v1", abi: "enclave-domain-abi/2", nonce: n, transportKey: "MFkw" } });

test("snp-app-fresh: the app origin's document over the caller's nonce, verbatim, with the key the origin presented", async () => {
  const w = world({ answer: good }); const nonce = Buffer.alloc(32, 7);
  const r = await w.fresh(HOST, DEP, nonce);
  assert.deepEqual(w.asked, [["9eb4e600.app.enclave.host", nonce.toString("hex")]], "one request, to the deployment's primary origin");
  assert.equal(appOrigin("app.enclave.host", DEP), "9eb4e600.app.enclave.host");
  assert.deepEqual(r.document, good(nonce.toString("hex")).doc); assert.equal(r.handshakeSpki, "MFkw");
  assert.equal(r.origin, `https://9eb4e600.app.enclave.host${ATTEST_PATH}`); assert.equal(r.expectedFrom, `/v1/expected-guest?id=${DEP}`);
});

test("snp-app-fresh: one check per box at a time and one per app per gap; a busy guest is busy; a foreign or missing report is refused; never retried", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const w = world({ answer: async (n) => { await gate; return good(n); } });
  w.rows["0x" + "d2".repeat(32)] = { ...w.rows[DEP], id: "0x" + "d2".repeat(32) };
  const first = w.fresh(HOST, DEP, Buffer.alloc(32, 1));
  await assert.rejects(w.fresh(HOST, "0x" + "d2".repeat(32), Buffer.alloc(32, 2)), (e) => e.code === "busy", "another app on the same box waits");
  release(); await first;
  await assert.rejects(w.fresh(HOST, DEP, Buffer.alloc(32, 3)), (e) => e.code === "busy" && e.retryAfter === 30, "the same app inside its gap");
  w.tick(31_000);
  await w.fresh(HOST, DEP, Buffer.alloc(32, 4));
  const busy = world({ answer: () => ({ status: 503, doc: null, handshakeSpki: "MFkw" }) });
  await assert.rejects(busy.fresh(HOST, DEP, Buffer.alloc(32, 5)), (e) => e.code === "busy"); assert.equal(busy.asked.length, 1, "not retried");
  const foreign = world({ answer: () => good("00".repeat(32)) });
  await assert.rejects(foreign.fresh(HOST, DEP, Buffer.alloc(32, 6)), (e) => e.code === "attestation_failed" && /another nonce/.test(e.message));
  const none = world({ answer: () => ({ status: 404, doc: null, handshakeSpki: "MFkw" }) });
  await assert.rejects(none.fresh(HOST, DEP, Buffer.alloc(32, 7)), (e) => e.code === "attestation_failed");
});

test("snp-app-fresh: only a public deployment leased to THIS snp box, a real id and nonce, and an app domain; nothing is fetched otherwise", async () => {
  const at = 1_000_000;
  const cases = [
    [{ ...HOST, mode: "hv-node" }, DEP, "no_box"],
    [HOST, "0x12", "bad_deployment"],
  ];
  for (const [host, id, code] of cases) { const w = world({ answer: good }); await assert.rejects(w.fresh(host, id, Buffer.alloc(32)), (e) => e.code === code); assert.equal(w.asked.length, 0); }
  for (const over of [{ isPublic: false }, { active: false }, { runner: "0x" + "bb".repeat(32) }, { leaseUntil: Math.floor(at / 1000) - 1 }]) {
    const w = world({ answer: good, rows: { [DEP]: { id: DEP, active: true, isPublic: true, runner: HOST.id, leaseUntil: lease(at), ...over } } });
    await assert.rejects(w.fresh(HOST, DEP, Buffer.alloc(32)), (e) => e.code === "not_here", JSON.stringify(over)); assert.equal(w.asked.length, 0);
  }
  const w = world({ answer: good }); await assert.rejects(w.fresh(HOST, DEP, Buffer.alloc(31)), (e) => e.code === "bad_nonce");
  const off = createSnpAppFresh({ confirmRow: async () => null }); await assert.rejects(off(HOST, DEP, Buffer.alloc(32)), (e) => e.code === "not_configured");
});
