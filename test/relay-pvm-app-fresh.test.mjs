// relay/pvm-app-fresh.mjs: ONE phone app VM's fresh evidence over a caller's nonce, asked of the app's own public origin with
// the key that origin presented, beside what the relay states: the catalog-derived app, the attach key, the operator's lists,
// and - for a VM that is not the box's own - the box's sibling statement over the SAME nonce and its registered proof key.
// Only an admitted pVM market host, a public deployment leased to it; one check per box at a time, one per app per gap, never
// retried; a busy VM is busy; an answer over another nonce is dropped.
//   run: node --test test/relay-pvm-app-fresh.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPvmAppFresh } from "../relay/pvm-app-fresh.mjs";

const HOST = { name: "pixel10-pvm-cpu", mode: "avf", id: "0x" + "c6".repeat(32) };
const DEP = "0x7f45af3e" + "d1".repeat(28), APP = "35".repeat(32);
const ATTACH = "302a300506032b6570032100" + "11".repeat(32), SLOT = "302a300506032b6570032100" + "22".repeat(32);
const PROOF = "0x26C1d63D" + "ab".repeat(16);

function world({ answer, spki = SLOT, rows, marketOn = true, eligible = true } = {}) {
  const asked = [], fetched = []; let clock = 1_000_000;
  rows = rows || { [DEP]: { id: DEP, active: true, isPublic: true, runner: HOST.id, leaseUntil: Math.floor(clock / 1000) + 3600 } };
  const hub = { info: (n) => (n === HOST.name ? { mode: "avf", spki: Buffer.from(ATTACH, "hex").toString("base64") } : null),
    fetchJson: async (_o, path) => { fetched.push(path); return { format: "enclave-pvm-sibling/v1", sig: "aa" }; } };
  const market = { enabled: marketOn, eligible: () => eligible, expectedApp: async () => ({ appId: APP }), proofKeyOf: async (id) => (id === HOST.id ? PROOF : null) };
  const fresh = createPvmAppFresh({ hub, market, appDomain: "app.enclave.host", confirmRow: async (id) => rows[id] || null, appGapMs: 30000, now: () => clock,
    operatorAllowlist: () => ({ source: "test", codeHashes: ["c0".repeat(32)] }),
    fetchOrigin: async (host, n) => { asked.push([host, n]); return answer ? answer(n) : { status: 200, handshakeSpki: "MFkw", doc: { format: "enclave-pvm-app-evidence/v4", nonce: n, spki } }; } });
  return { fresh, asked, fetched, tick: (ms) => { clock += ms; }, rows };
}

test("pvm-app-fresh: the app origin's evidence, verbatim, with the handshake key, the expected app, the attach key and the lists; a sibling VM brings its statement and the proof key", async () => {
  const w = world(); const nonce = Buffer.alloc(32, 7);
  const r = await w.fresh(HOST, DEP, nonce);
  assert.deepEqual(w.asked, [["7f45af3e.app.enclave.host", nonce.toString("hex")]], "one request, to the deployment's primary origin");
  assert.equal(r.handshakeSpki, "MFkw"); assert.equal(r.document.nonce, nonce.toString("hex"));
  assert.equal(r.expected.appSha256, APP); assert.match(r.expected.source, /catalog/);
  assert.equal(r.attachTransportKey, Buffer.from(ATTACH, "hex").toString("base64")); assert.equal(r.registryId, HOST.id);
  assert.deepEqual(w.fetched, [`/v1/pvm/sibling?deployment=${DEP}&nonce=${nonce.toString("hex")}`], "the sibling statement over the SAME nonce");
  assert.equal(r.proofKey, PROOF.toLowerCase()); assert.deepEqual(r.operatorAllowlist.codeHashes, ["c0".repeat(32)]);
  const own = world({ spki: ATTACH }); const o = await own.fresh(HOST, DEP, nonce);
  assert.equal(own.fetched.length, 0, "the box's own VM needs no statement"); assert.equal(o.sibling, null); assert.equal(o.proofKey, null);
});

test("pvm-app-fresh: one check per box at a time and one per app per gap; a busy VM is busy; a foreign or missing document is refused; never retried", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const w = world({ answer: async (n) => { await gate; return { status: 200, handshakeSpki: "MFkw", doc: { nonce: n, spki: SLOT } }; } });
  w.rows["0x" + "d2".repeat(32)] = { ...w.rows[DEP], id: "0x" + "d2".repeat(32) };
  const first = w.fresh(HOST, DEP, Buffer.alloc(32, 1));
  await assert.rejects(w.fresh(HOST, "0x" + "d2".repeat(32), Buffer.alloc(32, 2)), (e) => e.code === "busy");
  release(); await first;
  await assert.rejects(w.fresh(HOST, DEP, Buffer.alloc(32, 3)), (e) => e.code === "busy" && e.retryAfter === 30);
  const busy = world({ answer: () => ({ status: 429, doc: null, handshakeSpki: "MFkw" }) });
  await assert.rejects(busy.fresh(HOST, DEP, Buffer.alloc(32, 4)), (e) => e.code === "busy"); assert.equal(busy.asked.length, 1);
  const foreign = world({ answer: () => ({ status: 200, handshakeSpki: "MFkw", doc: { nonce: "00".repeat(32), spki: SLOT } }) });
  await assert.rejects(foreign.fresh(HOST, DEP, Buffer.alloc(32, 5)), (e) => e.code === "attestation_failed" && /another nonce/.test(e.message));
  assert.equal(foreign.fetched.length, 0, "no statement is asked for a dropped answer");
});

test("pvm-app-fresh: only an admitted market host, a public deployment leased to it, a real id and nonce; nothing is fetched otherwise", async () => {
  for (const [w, host, id, code] of [[world({ marketOn: false }), HOST, DEP, "not_configured"], [world({ eligible: false }), HOST, DEP, "no_box"],
                                     [world(), { ...HOST, mode: "snp" }, DEP, "no_box"], [world(), HOST, "0x12", "bad_deployment"]]) {
    await assert.rejects(w.fresh(host, id, Buffer.alloc(32)), (e) => e.code === code, code); assert.equal(w.asked.length, 0);
  }
  for (const over of [{ isPublic: false }, { active: false }, { runner: "0x" + "bb".repeat(32) }, { leaseUntil: 1 }]) {
    const w = world({ rows: { [DEP]: { id: DEP, active: true, isPublic: true, runner: HOST.id, leaseUntil: 9e9, ...over } } });
    await assert.rejects(w.fresh(HOST, DEP, Buffer.alloc(32)), (e) => e.code === "not_here", JSON.stringify(over)); assert.equal(w.asked.length, 0);
  }
});
