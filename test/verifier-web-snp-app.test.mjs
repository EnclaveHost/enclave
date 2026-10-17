// verifier/web/snp-app.mjs: ONE app's own SEV-SNP guest, verified in the browser, on AUTHENTIC evidence: metal0's app guest
// for deployment 0x9eb4e600… captured 2026-10-17 from the app's public origin (the document, the key that origin presented,
// the nonce, the relay's /v1/expected-guest prediction, the server's chip id, and the VCEK from AMD KDS).
// Proves: a genuine guest passes all 18 checks and is "limited" by the relay's prediction; a caller pin can reach "verified";
// and each substitution a relay or a neighbour could try is refused at the check that names it (another key, another nonce,
// another deployment, another app, an unpredicted measurement or runtime, another processor), never retried.
//   run: node --test test/verifier-web-snp-app.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { verifyEvidenceWeb, memoryCollateral } from "../verifier/web/index.mjs";
import { verifySnpAppWith, SNP_APP_CHECK_ORDER, RELAY_PREDICTED } from "../verifier/web/snp-app.mjs";
import { TCB_FLOORS } from "../verifier/metal-box.mjs";

const F = new URL("./fixtures/verifier/", import.meta.url), A = new URL("./fixtures/amd/", import.meta.url);
const cap = JSON.parse(fs.readFileSync(new URL("turin-m4a-app-2026-10-17/capture.json", F), "utf8"));
const collateral = memoryCollateral({ chains: { Turin: fs.readFileSync(new URL("Turin-cert_chain.pem", A), "utf8") },
  vceks: { Turin: fs.readFileSync(new URL("turin-m4a-app-2026-10-17/vcek-kds-amd.der", F)) }, crls: { Turin: fs.readFileSync(new URL("turin-m4a-app-2026-10-17/Turin-crl.der", F)) } });
const DEP = cap.deployment, NOW = new Date(cap.capturedAt);
const MEAS = Buffer.from(cap.doc.report, "base64").subarray(0x90, 0xc0).toString("hex");
const SERVER = () => ({ status: "limited", omissions: ["expected-measurement-operator-stated"], reasons: ["OMITTED"], measurement: "b8".repeat(48), claims: { chipId: cap.serverChipId } });
const json = (status, body) => new Response(JSON.stringify(body), { status });

// a world where the relay and the prediction answer from the capture, with one thing changed
function world({ app = (b) => b, expected = (b) => b, server = SERVER, nonce = cap.nonce } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes("/v1/expected-guest?id=")) { const r = expected(structuredClone(cap.expectedGuest)); return r instanceof Response ? r : json(200, r); }
    const m = /\/apps\/(0x[0-9a-f]{64})\/attestation\?nonce=([0-9a-f]{64})$/.exec(url);
    if (m) { const r = app({ name: "metal0", mode: "snp", deployment: m[1], nonce: m[2], fetchedAt: cap.capturedAt, origin: cap.origin, document: structuredClone(cap.doc), handshakeSpki: cap.handshakeSpki }); return r instanceof Response ? r : json(200, r); }
    return json(404, { error: "unexpected", url });
  };
  const deps = { fetchImpl, collateral, verify: verifyEvidenceWeb, tcbFloors: TCB_FLOORS, now: () => NOW, verifyBox: async () => server(),
                 randomBytes: () => Buffer.from(nonce, "hex") };
  return { calls, run: (opts = {}) => verifySnpAppWith(deps, { name: "metal0", deployment: DEP, ...opts }) };
}
const refusedAt = (v, key, re) => { assert.equal(v.status, "rejected", v.reasons.join("\n")); assert.equal(v.checks[key], false, `${key}: ${v.reasons.at(-1)}`); if (re) assert.match(v.reasons.at(-1), re); };

test("snp-app: the genuine app guest passes every check and is limited by the relay's prediction and the server's operator allowlist", async () => {
  const w = world(); const v = await w.run();
  assert.equal(v.status, "limited", v.reasons.join("\n"));
  for (const k of SNP_APP_CHECK_ORDER) assert.equal(v.checks[k], true, `${k}: ${v.reasons.join("\n")}`);
  assert.deepEqual(v.omissions, ["expected-measurement-operator-stated", RELAY_PREDICTED]);
  assert.equal(w.calls.length, 2, "one app request and one prediction, no retry");
  assert.match(v.summary, /same AMD processor as the server/);
  assert.ok(v.facts.some(([k, x]) => k === "Guest measurement" && x === MEAS));
});

test("snp-app: a caller's own measurement pin, on a server pinned too, reaches verified; a pin that does not match is refused", async () => {
  const pinnedServer = () => ({ ...SERVER(), status: "verified", omissions: [] });
  const ok = await world({ server: pinnedServer }).run({ expected: { measurements: [MEAS] } });
  assert.equal(ok.status, "verified", ok.reasons.join("\n")); assert.deepEqual(ok.omissions, []);
  refusedAt(await world({ server: pinnedServer }).run({ expected: { measurements: ["00".repeat(48)] } }), "measurement");
});

test("snp-app: another key than the app's certificate carries is refused, whether the document or both sides name it", async () => {
  const other = Buffer.from(cap.handshakeSpki, "base64"); other[other.length - 1] ^= 1;
  refusedAt(await world({ app: (b) => ({ ...b, handshakeSpki: other.toString("base64") }) }).run(), "app-document", /another key/);
  const both = (b) => ({ ...b, handshakeSpki: other.toString("base64"), document: { ...b.document, transportKey: other.toString("base64") } });
  refusedAt(await world({ app: both }).run(), "binding", /Bind2|binding/);
});

test("snp-app: an answer over another nonce, for another deployment or host, or a report from another processor is refused", async () => {
  refusedAt(await world({ nonce: "11".repeat(32) }).run(), "app-document");   // the relay answers the capture's report to a fresh nonce
  const v = await world({ app: (b) => ({ ...b, nonce: "22".repeat(32) }) }).run(); assert.equal(v.status, "rejected"); assert.match(v.reasons.at(-1), /another nonce/);
  const d = await world({ app: (b) => ({ ...b, deployment: "0x" + "ab".repeat(32) }) }).run(); assert.equal(d.status, "rejected"); assert.match(d.reasons.at(-1), /another deployment/);
  // the same genuine report asked under ANOTHER deployment id: the processor-signed HOST_DATA names the real one
  const other = "0x" + "cd".repeat(32);
  refusedAt(await world({ expected: (b) => ({ ...b, id: other }) }).run({ deployment: other }), "host data");
  refusedAt(await world({ server: () => ({ ...SERVER(), claims: { chipId: "ff".repeat(64) } }) }).run(), "same-chip", /another processor/);
});

test("snp-app: another app, an unpredicted measurement or an unlisted runtime is refused at the check that names it", async () => {
  refusedAt(await world({ expected: (b) => ({ ...b, appId: "ee".repeat(32) }) }).run(), "app-identity");
  refusedAt(await world({ expected: (b) => ({ ...b, images: b.images.filter((i) => i.measurement !== MEAS) }) }).run(), "measurement");
  refusedAt(await world({ expected: (b) => ({ ...b, images: b.images.map((i) => ({ ...i, runtimeId: "aa".repeat(32) })) }) }).run(), "app-runtime");
  refusedAt(await world({ app: (b) => ({ ...b, document: { ...b.document, runtime: { ...b.document.runtime, version: "48.0.0" } } }) }).run(), "app-runtime");
});

test("snp-app: nothing about the app is asked unless the server verified; busy and warming are errors, not verdicts, and never retried", async () => {
  const w = world({ server: () => ({ status: "rejected", reasons: ["REJECT: measurement"], claims: {} }) });
  const v = await w.run(); assert.equal(v.status, "rejected"); assert.equal(v.checks.server, false); assert.equal(w.calls.length, 0);
  const busy = world({ app: () => json(503, { error: "busy", retryAfter: 30 }) });
  const b = await busy.run(); assert.equal(b.status, "error"); assert.match(b.reasons.at(-1), /busy/); assert.equal(busy.calls.length, 1);
  const warm = world({ expected: () => json(503, { error: "warming", retryAfterSec: 5 }) });
  const p = await warm.run(); assert.equal(p.status, "error"); assert.match(p.reasons.at(-1), /still predicting/);
  assert.equal((await world().run({ deployment: "0x12" })).status, "error");
});
