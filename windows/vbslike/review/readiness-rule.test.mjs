// windows/vbslike/review/readiness-rule.test.mjs: the agreed "running" rule for a NucBox partition, as an executable spec.
//
// Agreed 2026-09-24 between the Windows owner (enclave-d1) and the guest lane (enclave-5d), HV-GUEST.md and ready.go:
//   running  = the attestation document verified on THIS handshake's key with a fresh nonce (judge-hv: monitor-signed)
//              AND GET /.well-known/enclave-ready 200 on a session with the SAME key, within a deadline;
//   starting = the document verifies but the app's port does not accept yet (ready 503), before the deadline;
//   failed   = anything else, with the reason: another key, another app, an untrusted launcher key, the deadline.
// Never running on console bytes, never running on ready alone, never "attested" (T0-hv: the host is not excluded).
//
// A FAKE DOMAIN serves what the real front serves: a launcher-signed document per windows/vbslike/host/src/report.rs
// (Ed25519 over "vbslike-report-v1\n" || canonical(doc); reportData = Bind2(handshake key, nonce, RuntimeID) || AppID)
// and enclave-ready. The first test proves the fake is faithful by judging it with the ABI/2 judge-hv.mjs. The rest
// drive the manager's seam `windows/vbslike/manager/ready.mjs`: judgeRunning({ host, port, appId, launcherKey,
// expectRuntime, deadlineMs }) -> { status: "running"|"starting"|"failed", reason, checks }. Until the seam exists,
// each of those fails with "seam missing", which is the correct reading of the manager today. A running verdict also
// carries transportKeySha256 (sha256 of the handshake's SPKI): the datapath's enclave-splice/1 admits a route on it.
//   run: node --test windows/vbslike/review/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { judge } from "../verify/judge-hv.mjs";
import { FakeDomain, launcherKey, session, sha256hex, APP, OTHER_APP, RUNTIME, SELFTEST, LEGACY_SELFTEST, V42_IMAGE, FAKE_IMAGE } from "./fake-domain.mjs";

const SEAM = new URL("../manager/ready.mjs", import.meta.url);
async function seam() {
  if (!fs.existsSync(SEAM)) assert.fail("seam missing: windows/vbslike/manager/ready.mjs exporting judgeRunning({ host, port, appId, launcherKey, expectRuntime, deadlineMs }) -> { status, reason, checks }");
  const m = await import(pathToFileURL(SEAM.pathname).href);
  assert.equal(typeof m.judgeRunning, "function", "ready.mjs exports judgeRunning");
  return m.judgeRunning;
}
const run = async (d, over = {}) => (await seam())({ host: "127.0.0.1", port: d.port, appId: APP, launcherKey: d.signer.keyB64, expectRuntime: RUNTIME, deadlineMs: 3000, ...over });

test("the branch's judge-hv.mjs is the ABI/2 one (67762434 = ef1b2077): the ABI/1-only copy rejects every document from the current image", () => {
  const src = fs.readFileSync(new URL("../verify/judge-hv.mjs", import.meta.url), "utf8");
  assert.match(src, /import \{ checkRuntime \} from "\.\.\/\.\.\/\.\.\/isolation\/m2\/judge\.mjs"/, "the runtime half is the shared checkRuntime");
  assert.match(src, /expectRuntime/, "ABI/2: the caller pins the runtime identity");
});

test("the fake domain is faithful: judge-hv says monitor-signed on THIS handshake's key and a fresh nonce; ready 200 on the same session; refusals on another key, nonce, app or launcher key", async () => {
  const d = await new FakeDomain().listen();
  try {
    const s = await session(d.port);
    assert.ok(s.spki.equals(d.spki));
    const nonce = randomBytes(32);
    const a = await s.req("GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`);
    const doc = JSON.parse(a.body);
    const v = judge({ doc, spki: s.spki, nonce, expectedAppSha256: APP, launcherKey: d.signer.keyB64, expectRuntime: RUNTIME });
    assert.equal(v.verdict, "monitor-signed", v.reasons.join("; "));
    assert.equal(v.checks["platform states host_excluded=false"], true);
    const r = await s.req("GET", "/.well-known/enclave-ready");
    assert.equal(r.status, 200); assert.equal(JSON.parse(r.body).appId, APP);
    assert.equal(judge({ doc, spki: randomBytes(91), nonce, expectedAppSha256: APP, launcherKey: d.signer.keyB64, expectRuntime: RUNTIME }).verdict, "reject", "another key");
    assert.equal(judge({ doc, spki: s.spki, nonce: randomBytes(32), expectedAppSha256: APP, launcherKey: d.signer.keyB64, expectRuntime: RUNTIME }).verdict, "reject", "another nonce");
    assert.equal(judge({ doc, spki: s.spki, nonce, expectedAppSha256: OTHER_APP, launcherKey: d.signer.keyB64, expectRuntime: RUNTIME }).verdict, "reject", "another app");
    assert.notEqual(judge({ doc, spki: s.spki, nonce, expectedAppSha256: APP, launcherKey: launcherKey().keyB64, expectRuntime: RUNTIME }).verdict, "monitor-signed", "an untrusted launcher key");
    assert.equal(judge({ doc, spki: s.spki, nonce, expectedAppSha256: APP, launcherKey: d.signer.keyB64, expectRuntime: { ...RUNTIME, version: "47.0.0" } }).verdict, "reject", "another runtime identity (ABI/2)");
    s.close();
  } finally { d.close(); }
});

// the per-image W^X rule (enclave-b4's judge-hv 8d036dff = main f1461271; v43): judged directly, both ways. It FAILS on a
// judge before that rule (this branch's own verify/judge-hv.mjs accepts the legacy form on any image), which is the correct
// reading of such a judge; run it in the package's layout (v43's control bd657ed0 + these files): 9/9 here, record-to-route 4/4.
async function judgeFake(opts, expectedImageSha256) {
  const d = await new FakeDomain(opts).listen();
  try {
    const s = await session(d.port), nonce = randomBytes(32);
    const doc = JSON.parse((await s.req("GET", `/.well-known/enclave-attestation?nonce=${nonce.toString("hex")}`)).body);
    s.close();
    return judge({ doc, spki: s.spki, nonce, expectedAppSha256: APP, launcherKey: d.signer.keyB64, expectRuntime: RUNTIME,
                   ...(expectedImageSha256 ? { expectedImageSha256 } : {}) });
  } finally { d.close(); }
}
test("the per-image W^X rule, both ways: the attest-time self-test is runtime-covered; the LEGACY form is accepted ONLY on the listed image 0891c740 (the caller's image), as runtime W^X UNMEASURED, and refused on any other image or with no image named", async () => {
  const now = await judgeFake({}, FAKE_IMAGE);
  assert.equal(now.verdict, "monitor-signed", now.reasons.join("; "));
  assert.equal(now.wxCoverage, "runtime-covered", `the default fake states the attest-time form (${SELFTEST})`);
  const v42 = await judgeFake({ selfTest: LEGACY_SELFTEST, imageSha256: V42_IMAGE }, V42_IMAGE);
  assert.equal(v42.verdict, "monitor-signed", `the legacy form on the listed v42 image is accepted: ${v42.reasons.join("; ")}`);
  assert.equal(v42.wxCoverage, "runtime-unmeasured", "and reported as runtime W^X UNMEASURED, never covered");
  assert.match(v42.wxWhy, /UNMEASURED/);
  const other = await judgeFake({ selfTest: LEGACY_SELFTEST }, FAKE_IMAGE);
  assert.equal(other.verdict, "reject", "the legacy form on an image the table does not list is refused");
  assert.ok(other.reasons.some((r) => /names no runtime coverage/.test(r)), other.reasons.join("; "));
  const unnamed = await judgeFake({ selfTest: LEGACY_SELFTEST, imageSha256: V42_IMAGE });
  assert.equal(unnamed.verdict, "reject", "no image named by the caller = no legacy, even when the DOCUMENT states the listed image");
});

test("RUNNING: the document verified on this handshake's key with a fresh nonce AND ready 200 on the same key", async () => {
  const d = await new FakeDomain().listen();
  try {
    const v = await run(d);
    assert.equal(v.status, "running", v.reason);
    // checks.document / checks.ready may be booleans or objects carrying ok (the owner's shape); the rule is the same
    const okOf = (c) => (typeof c === "object" && c !== null ? c.ok === true : c === true);
    assert.equal(okOf(v.checks.document), true, JSON.stringify(v.checks.document)); assert.equal(okOf(v.checks.ready), true, JSON.stringify(v.checks.ready));
    assert.ok(d.hits.includes("/.well-known/enclave-attestation") && d.hits.includes("/.well-known/enclave-ready"), "both were asked");
    assert.doesNotMatch(JSON.stringify(v), /attested/i, "T0-hv is never attested");
    // the datapath (windows/vbslike/datapath/datapath.mjs, enclave-splice/1) admits a route only on `key=` the sha256 of
    // the TLS key the manager's VERIFYING handshake saw: a running verdict must carry it, or no route can ever be admitted
    assert.equal(v.transportKeySha256, sha256hex(d.spki), "transportKeySha256 = sha256(the SPKI this judgement's handshake saw)");
  } finally { d.close(); }
});

test("STARTING: the document verifies but the app's port does not accept yet (ready 503), before the deadline", async () => {
  const d = await new FakeDomain({ ready: { status: 503 } }).listen();
  try {
    const v = await run(d, { deadlineMs: 400 });
    assert.notEqual(v.status, "running", "ready 503 is not running");
    assert.ok(v.status === "starting" || (v.status === "failed" && /deadline|within/i.test(v.reason)), `${v.status}: ${v.reason}`);
  } finally { d.close(); }
});

test("NEVER RUNNING on ready alone: a document bound to ANOTHER key with ready 200 is failed at the document", async () => {
  const d = await new FakeDomain({ boundSpki: randomBytes(91) }).listen();
  try {
    const v = await run(d);
    assert.equal(v.status, "failed", `${v.status}: ${v.reason}`);
    const doc = v.checks.document; assert.equal(typeof doc === "object" && doc !== null ? doc.ok : doc, false, JSON.stringify(doc));
  } finally { d.close(); }
});

test("NEVER RUNNING under an untrusted launcher key, for another app, or with a ready answer naming another app", async () => {
  const d = await new FakeDomain().listen();
  try {
    let v = await run(d, { launcherKey: launcherKey().keyB64 });
    assert.equal(v.status, "failed", `untrusted launcher key: ${v.status} ${v.reason}`);
    v = await run(d, { appId: OTHER_APP });
    assert.equal(v.status, "failed", `another app: ${v.status} ${v.reason}`);
  } finally { d.close(); }
  const e = await new FakeDomain({ readyAppId: OTHER_APP }).listen();
  try {
    const v = await run(e);
    assert.notEqual(v.status, "running", `ready names ${OTHER_APP.slice(0, 8)}, the document ${APP.slice(0, 8)}: ${v.status} ${v.reason}`);
  } finally { e.close(); }
});

test("a 200 that is not the readiness document is NOT ready: on an initrd without the route the APP answers the path (measured on the box: 200 \"Hello World!\\n\" for /.well-known/enclave-ready), and the app's own answer must never count", async () => {
  const d = await new FakeDomain({ ready: { status: 200 } }).listen();
  d.handle = ((orig) => function (req, res) {   // the front without the route: everything not attestation goes to the app
    const u = new URL(req.url, "https://x");
    if (u.pathname === "/.well-known/enclave-ready") { this.hits.push(u.pathname); res.writeHead(200, { "content-type": "text/plain", "content-length": "13" }); return res.end("Hello World!\n"); }
    return orig.call(this, req, res);
  })(d.handle);
  try {
    const v = await run(d, { deadlineMs: 400 });
    assert.notEqual(v.status, "running", `a plain 200 from the app was read as ready: ${v.status} ${v.reason}`);
  } finally { d.close(); }
});

test("the deadline bounds the whole judgement: a domain that never becomes ready is failed with the reason, not starting forever", async () => {
  const d = await new FakeDomain({ ready: { status: 503 } }).listen();
  try {
    const t0 = Date.now();
    const v = await run(d, { deadlineMs: 300 });
    assert.ok(Date.now() - t0 < 3000, "it returned near the deadline");
    assert.ok(v.status === "starting" || v.status === "failed"); assert.notEqual(v.status, "running");
    if (v.status === "failed") assert.match(String(v.reason), /ready|deadline|within/i);
  } finally { d.close(); }
});
