// The per-app tier's WebPKI certificate gate holds an SEV-SNP guest to the RELAY's prediction (GUEST-POOL-ROLLOUT section
// 9, row 6; isolation/m4/guestd/supervisor-guestcert.mjs). Before it, the measurement a guest was judged against and the
// AppID it had to name were both guestd's (the host's) word, so a host running a modified image with the right HOST_DATA
// could have had it certified for the deployment's name. What must hold:
//   - nothing is issued unless guestd's AppID is the relay's predicted AppID and the guest's measurement is one predicted
//     image's, and (after the judge) the runtime its report binds is that image's runtime;
//   - no expected-guest source, a relay that is unreachable, answers 503 or is not the WebPKI-verified origin: nothing
//     issued, with a retry hint the loop cannot outrun;
//   - a certificate the guest already serves is kept (nothing fetched, nothing issued), and a T0-hv partition route,
//     which has no measurement, is judged as before.
// Every key and certificate here is generated per run by openssl: throwaways.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { holdToPrediction, runtimePairs, expectedGuestFetcher, ensureGuestCert, csrSpki } from "../isolation/m4/guestd/supervisor-guestcert.mjs";
import { ABI2, runtimeId } from "../isolation/contract/runtime.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const DEP = "0x" + "4e".repeat(32), APP = "ab".repeat(32), MEAS = "cd".repeat(48), OTHER_MEAS = "ce".repeat(48);
const NAME = "4e4e4e4e.app.enclave.host";
const RUNTIME = { name: "wasmtime", version: "48.0.1", execution: "jit", targetIsa: "x86_64", hostIsa: "x86_64",
                  cpuFeatures: "host-detected", wx: "enforced", cache: "none" };
const RID = runtimeId(RUNTIME).toString("hex");
const expectedOk = () => ({ id: DEP, catalogRef: "catalog://0x" + "11".repeat(32) + "/4", appId: APP,
  images: [{ release: "5c".repeat(32), runtimeId: RID, measurement: MEAS, releaseAdmitted: false },
           { release: "08".repeat(32), runtimeId: "77".repeat(32), measurement: OTHER_MEAS, releaseAdmitted: true }] });

// one P-256 key, a CSR for exactly {CN=NAME, SAN=[NAME]} and a self-signed leaf for the same key and name
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guestcert-"));
const ossl = (...a) => execFileSync("openssl", a, { stdio: ["ignore", "pipe", "ignore"] });
ossl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", path.join(dir, "k.pem"));
fs.writeFileSync(path.join(dir, "ext"), `subjectAltName=DNS:${NAME}\n`);
ossl("req", "-new", "-key", path.join(dir, "k.pem"), "-subj", `/CN=${NAME}`, "-addext", `subjectAltName=DNS:${NAME}`, "-out", path.join(dir, "csr.pem"));
ossl("req", "-x509", "-key", path.join(dir, "k.pem"), "-subj", `/CN=${NAME}`, "-addext", `subjectAltName=DNS:${NAME}`, "-days", "30", "-out", path.join(dir, "leaf.pem"));
const CSR = fs.readFileSync(path.join(dir, "csr.pem"), "utf8"), LEAF = fs.readFileSync(path.join(dir, "leaf.pem"), "utf8");
const KEY = sha(csrSpki(CSR));
assert.equal(sha(new X509Certificate(LEAF).publicKey.export({ type: "spki", format: "der" })), KEY);

const doc = (over = {}) => ({ format: "sev-snp-guest-domain-v1", abi: ABI2, runtime: RUNTIME, ...over });
// one run of the gate with every network step faked; returns what happened
async function run({ route = { id: "gd0a0b0c0d", appId: APP, measurement: MEAS, runtimeId: RID, key: KEY }, expected = async () => expectedOk(),
                     noExpected = false, reusable = null, attestation = doc(), verdict = "attested", expectAppId = APP } = {}) {
  const calls = { expected: 0, judge: [], issue: 0, exchanges: [] };
  const deps = {
    routeFor: async () => route,
    servedReusable: async () => reusable,
    exchange: async (_a, _r, _n, method, p, body) => {
      calls.exchanges.push(`${method} ${p.split("?")[0]}`);
      if (p.startsWith("/.well-known/enclave-attestation")) return { status: 200, body: Buffer.from(JSON.stringify(attestation)), spki: Buffer.alloc(0) };
      if (p === "/.well-known/enclave-csr") return { status: 200, body: Buffer.from(CSR) };
      if (p === "/.well-known/enclave-cert") return { status: 200, body: Buffer.from("{}") };
      throw new Error("unexpected " + p);
    },
  };
  let out, err;
  try {
    out = await ensureGuestCert({ transport: {}, dataAddr: "127.0.0.1:1", instanceId: route.id, expectAppId, deploymentId: DEP, name: NAME,
      judge: async (_d, _s, _n, want) => { calls.judge.push(want); return { verdict, reasons: [] }; },
      issue: async () => { calls.issue++; return LEAF; },
      ...(noExpected ? {} : { expected: async (id) => { calls.expected++; return expected(id); } }),
      _deps: deps });
  } catch (e) { err = e; }
  return { out, err, calls };
}

test("holdToPrediction: guestd's AppID and the guest's measurement must be the relay's prediction", () => {
  const want = { deploymentId: DEP, appId: APP, measurement: MEAS };
  const ok = holdToPrediction(expectedOk(), want);
  assert.equal(ok.ok, true);
  assert.equal(ok.image.runtimeId, RID);
  assert.equal(holdToPrediction(expectedOk(), { ...want, deploymentId: DEP.toUpperCase().replace("0X", "0x"), appId: APP.toUpperCase(), measurement: MEAS.toUpperCase() }).ok, true, "hex case is not identity");
  const bad = (exp, w, re) => { const r = holdToPrediction(exp, { ...want, ...w }); assert.equal(r.ok, false); assert.match(r.why, re); };
  bad(null, {}, /no expected guest/);
  bad({ ...expectedOk(), id: "0x" + "99".repeat(32) }, {}, /another deployment/);
  bad({ ...expectedOk(), appId: "zz" }, {}, /malformed/);
  bad(expectedOk(), { appId: "ef".repeat(32) }, /not the relay's predicted/);
  bad({ ...expectedOk(), images: [] }, {}, /predicted no image/);
  bad({ ...expectedOk(), images: [{ measurement: "short", runtimeId: RID }] }, {}, /predicted no image/);
  bad(expectedOk(), { measurement: "aa".repeat(48) }, /no predicted image's/);
});

test("runtimePairs: the report's bound runtime must be the matched image's", () => {
  const image = expectedOk().images[0];
  assert.equal(runtimePairs(doc(), image).ok, true);
  assert.match(runtimePairs(doc({ abi: "enclave-domain-abi/1" }), image).why, /binds no runtime/);
  assert.match(runtimePairs(doc({ runtime: undefined }), image).why, /binds no runtime/);
  assert.match(runtimePairs(doc({ runtime: { ...RUNTIME, version: "49.0.0" } }), image).why, /not the predicted image's/);
  assert.equal(runtimePairs(doc({ runtime: { ...RUNTIME, wx: "whatever" } }), image).ok, false, "an inadmissible identity pairs with nothing");
});

test("ensureGuestCert issues for a guest that is the relay's prediction, and judges it against the predicted measurement", async () => {
  const r = await run();
  assert.equal(r.err, undefined, r.err && r.err.message);
  assert.equal(r.calls.issue, 1);
  assert.equal(r.calls.expected, 1);
  assert.equal(r.calls.judge[0].measurement, MEAS);
  assert.equal(r.calls.judge[0].appSha, APP);
  assert.equal(r.out.release, "5c".repeat(32));
});

test("ensureGuestCert issues NOTHING when the guest is not the relay's prediction, or the prediction cannot be had", async () => {
  const cases = {
    "no expected-guest source": { noExpected: true },
    "relay unreachable": { expected: async () => { throw new Error("fetch failed"); } },
    "relay 503": { expected: async () => { throw Object.assign(new Error("the relay's expected guest answered HTTP 503 warming"), { retryMs: 60_000 }); } },
    "AppID mismatch (guestd names another app)": { expected: async () => ({ ...expectedOk(), appId: "ef".repeat(32) }) },
    "measurement not predicted (a modified image)": { route: { id: "gd0a0b0c0d", appId: APP, measurement: "aa".repeat(48), runtimeId: RID, key: KEY } },
    "prediction for another deployment": { expected: async () => ({ ...expectedOk(), id: "0x" + "99".repeat(32) }) },
    "runtime not the matched image's": { attestation: doc({ runtime: { ...RUNTIME, version: "49.0.0" } }) },
    "report binds no runtime": { attestation: doc({ abi: "enclave-domain-abi/1" }) },
  };
  for (const [what, opts] of Object.entries(cases)) {
    const r = await run(opts);
    assert.ok(r.err, `${what}: must throw`);
    assert.equal(r.calls.issue, 0, `${what}: nothing may be issued`);
    assert.ok(!r.calls.exchanges.includes("GET /.well-known/enclave-csr"), `${what}: no CSR is even asked for`);
  }
});

test("a certificate the guest already serves is kept: nothing fetched from the relay, nothing issued", async () => {
  const r = await run({ reusable: { serial: "01", issuer: "CN=R11", notAfter: Date.now() + 86400_000, renewAt: Date.now() + 3600_000 },
                        expected: async () => { throw new Error("must not be asked"); } });
  assert.equal(r.err, undefined);
  assert.equal(r.out.reused, true);
  assert.equal(r.calls.expected, 0);
  assert.equal(r.calls.issue, 0);
});

test("a T0-hv partition route (no measurement) is judged as before and needs no relay prediction", async () => {
  const r = await run({ route: { id: "p-1", appId: APP, image: "99".repeat(32), runtimeId: RID, key: KEY }, noExpected: true });
  assert.equal(r.err, undefined, r.err && r.err.message);
  assert.equal(r.calls.issue, 1);
  assert.equal(r.calls.judge[0].measurement, undefined);
});

test("expectedGuestFetcher: only a WebPKI-verified https relay answers; 503 gives a retry the loop cannot outrun; 200 is kept", async () => {
  // a MITM: an https server whose certificate no WebPKI root signed. The real fetch must refuse it.
  const srv = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: LEAF }, (_q, s) => {
    s.writeHead(200, { "content-type": "application/json" }); s.end(JSON.stringify(expectedOk()));
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const mitm = expectedGuestFetcher({ base: `https://127.0.0.1:${srv.address().port}` });
    await assert.rejects(() => mitm(DEP), (e) => !/answered HTTP 200/.test(e.message), "an untrusted certificate must fail the fetch");
    const r = await run({ expected: mitm });
    assert.equal(r.calls.issue, 0, "a MITM answer issues nothing");
  } finally { await new Promise((r) => srv.close(r)); }

  await assert.rejects(() => expectedGuestFetcher({ base: "http://api.enclave.host" })(DEP), /no https relay origin/);
  await assert.rejects(() => expectedGuestFetcher({ base: "" })(DEP), /no https relay origin/);
  await assert.rejects(() => expectedGuestFetcher({ base: "https://api.enclave.host/evil" })(DEP), /no https relay origin/);

  let n = 0; const seen = [];
  const answer = (status, body) => async (url, init) => { n++; seen.push({ url, init }); return { status, json: async () => body }; };
  const f503 = expectedGuestFetcher({ base: "https://api.enclave.host", fetchImpl: answer(503, { error: "warming", retryAfterSec: 5 }) });
  await assert.rejects(() => f503(DEP), (e) => e.retryMs === 60_000 && /HTTP 503 warming/.test(e.message));
  const f404 = expectedGuestFetcher({ base: "https://api.enclave.host", fetchImpl: answer(404, { error: "no_deployment" }) });
  await assert.rejects(() => f404(DEP), /HTTP 404 no_deployment; nothing issued/);

  n = 0; seen.length = 0; let t = 1_000;
  const f200 = expectedGuestFetcher({ base: "https://api.enclave.host/", fetchImpl: answer(200, expectedOk()), now: () => t });
  assert.equal((await f200(DEP)).appId, APP);
  assert.equal(seen[0].url, `https://api.enclave.host/v1/expected-guest?id=${DEP}`);
  assert.equal(seen[0].init.redirect, "error", "a redirect is never followed");
  await f200(DEP); assert.equal(n, 1, "kept within cacheMs");
  t += 11 * 60_000; await f200(DEP); assert.equal(n, 2, "asked again after cacheMs");
  await assert.rejects(() => f200("0xnot-an-id"), /not a deployment id/);
});
