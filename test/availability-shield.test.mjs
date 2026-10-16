// Enclave Shield in the paid capacity audit (availability/shield.mjs, the Shield branch of availability/verified-http.mjs,
// the workload's prepare step): the fresh TPM session over OUR nonce and credential against a stand-in relay + node, the
// relay's busy answers waited out (>= 20 s, jittered, bounded; one check per box at a time, >= 20 s apart), the witness's
// verify hook (the witness itself: test/availability-witness.test.mjs), the expectation loader (our ledger read, our derivation, the session LAST), the raw-CID fetcher, and the
// requires* flags reaching the app policy.
//   run: node --test test/availability-shield.test.mjs   (the TPM flow needs openssl)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, createHash, sign as cryptoSign } from "node:crypto";
import { hvNodeBinding } from "../relay/hvnode-verify.mjs";
import { activateCredential } from "../relay/vbs-credential.mjs";
import { haveOpenssl, tmpdir, makeVbsWorld, buildLog, buildQuote, nameOf, tpmtPublicOf } from "./fixtures/vbs-synthetic.mjs";
import { createShieldHostChecker, shieldWitnessVerifier, shieldAvailability, shieldHardwareId, shieldPolicyLoader, createShieldExpectations,
         rawCidFetcher, relayBusy, backoffMs, shieldBoxName } from "../availability/shield.mjs";
import { verifiedAppRequest } from "../availability/verified-http.mjs";
import { createCpuWorkload } from "../availability/workload.mjs";

const sha = (...p) => { const h = createHash("sha256"); for (const x of p) h.update(x); return h.digest(); };
const b64 = (b) => Buffer.from(b).toString("base64");
const hex = (b) => Buffer.from(b).toString("hex");
const POLICY_FILE = new URL("../windows/installer/admitted-shield-policy.json", import.meta.url);
const STATEMENT = Buffer.from(JSON.stringify({ stated: true }));
const world = haveOpenssl ? makeVbsWorld(tmpdir("audit-shield-")) : null;

// the node's evidence for (nonce, credential), as relay/hvnode-verify.mjs receives it
function frame(w, { nonce, credential, log = {} }) {
  const bound = hvNodeBinding(w.transport.spki, nonce, STATEMENT);
  const L = buildLog({ idksPub: w.idks.publicKey, ...log });
  const Q = buildQuote({ aikPriv: w.aik.privateKey, aikName: w.aik.name, pcrs: L.pcrs, pcr0: w.pcr0, extraData: sha(bound) });
  return { statement: b64(STATEMENT), signature: b64(cryptoSign(null, bound, w.transport.privateKey)), log: b64(L.log),
           quote: { attest: b64(Q.attest), sig: b64(Q.sig), aikPub: b64(w.aik.tpmtPublic) }, credential: b64(credential),
           ek: { cert: b64(w.ek.cert), chain: [b64(w.ca.inter)] }, pcr0: w.pcr0.toString("hex"), platform: {} };
}
// the relay + the node's TPM: step 1 answers the keys for our nonce, step 2 activates OUR credential with the EK's private key.
// script: a list of overrides per step-1 call ({ status, body }) to play busy answers first.
function standIn(w, { script = [], keys: keyOver = {}, credential: madeUp = null, log = {} } = {}) {
  const calls = []; let nonce = null, n1 = 0;
  const answer = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body, method: init.method });
    if (url.endsWith("/attestation")) {
      const s = script[n1++]; if (s) return answer(s.status, s.body);
      nonce = Buffer.from(body.nonce, "hex");
      return answer(200, { name: "nucbox-test", mode: "hv-node", session: "ab".repeat(24), nonce: body.nonce,
                           keys: { ek: b64(w.ek.cert), ekChain: [b64(w.ca.inter)], aikPub: b64(w.aik.tpmtPublic), aikName: b64(w.aik.name), ...keyOver } });
    }
    if (url.endsWith("/attestation/credential")) {
      assert.equal(body.session, "ab".repeat(24));
      const credential = madeUp || activateCredential(w.ek.privateKey, w.aik.name, Buffer.from(body.credentialBlob, "base64"), Buffer.from(body.secret, "base64"));
      return answer(200, { name: "nucbox-test", mode: "hv-node", document: { format: "windows-hv-node/v1", body: b64(Buffer.from(JSON.stringify(frame(w, { nonce, credential, log })))), transportKey: b64(w.transport.spki) } });
    }
    return answer(404, { error: "not_found" });
  };
  return { fetchImpl, calls };
}
// a fake clock: sleep advances it, and records what was slept
function clock(start = 1_800_000_000_000) {
  let t = start; const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, slept, advance: (ms) => { t += ms; } };
}
const checker = (w, s, c, o = {}) => createShieldHostChecker({ relay: "https://api.test", ekRoots: w.ca.bundlePem, fetchImpl: s.fetchImpl, now: c.now, sleep: c.sleep, random: () => 0.5, ...o });

test("shield session: our nonce, our AIK name, our credential recovered by that TPM; the verdict admissible and the EK identity recorded", { skip: !haveOpenssl && "openssl absent" }, async () => {
  const s = standIn(world), c = clock();
  const r = await checker(world, s, c).session("nucbox-test");
  assert.equal(r.verdict.ok, true, r.verdict.reasons.join("\n")); assert.equal(r.verdict.admissible, true); assert.equal(r.verdict.hostExcluded, false);
  assert.equal(r.ekCertSha256, hex(sha(world.ek.cert))); assert.equal(r.atMs, c.now());
  assert.deepEqual(s.calls.map((x) => x.url), ["https://api.test/v1/enclaves/nucbox-test/attestation", "https://api.test/v1/enclaves/nucbox-test/attestation/credential"]);
  assert.match(s.calls[0].body.nonce, /^[0-9a-f]{64}$/); assert.equal(hex(r.session.nonce), s.calls[0].body.nonce);
  assert.ok(r.session.mintedFor.aikName.equals(nameOf(world.aik.tpmtPublic))); assert.ok(r.session.mintedFor.ekCert.equals(world.ek.cert));
  assert.ok(r.session.transportKeySpki.equals(world.transport.spki)); assert.equal(r.session.expectedCredential.length, 32);
  assert.deepEqual(c.slept, [], "nothing to wait for");
  // the witness's verify hook: allowlisted EK -> its sha256 is the identity and the hardware id basis
  const v = shieldWitnessVerifier({ check: r }, { allowedMeasurements: [r.ekCertSha256.toUpperCase()] });
  assert.deepEqual(v, { ok: true, measurement: r.ekCertSha256, chipId: r.ekCertSha256 });
  assert.match(shieldWitnessVerifier({ check: r }, { allowedMeasurements: ["00".repeat(32)] }).reason, /not on the allowlist/);
  assert.equal(shieldWitnessVerifier({}, { allowedMeasurements: [r.ekCertSha256] }).ok, false);
});

test("shield session refuses: a credential the relay made up, a relay aikName that is not ours (nothing minted), a non-restricted AIK, test signing, another nonce, another mode", { skip: !haveOpenssl && "openssl absent" }, async () => {
  const run = (o) => { const s = standIn(world, o); return { s, p: checker(world, s, clock()).session("nucbox-test") }; };
  let { s, p } = run({ credential: randomBytes(32) }); await assert.rejects(p, /^Error: Shield host session refused: .*credential/);
  ({ s, p } = run({ keys: { aikName: b64(Buffer.concat([Buffer.from([0, 0x0b]), randomBytes(32)])) } }));
  await assert.rejects(p, /refused: the relay's aikName/); assert.equal(s.calls.length, 1, "nothing is minted for keys that do not check");
  ({ s, p } = run({ keys: { aikPub: b64(tpmtPublicOf(world.aik.publicKey, { attributes: 0x00070072 })) } })); await assert.rejects(p, /refused: the quoting key/); assert.equal(s.calls.length, 1);
  ({ p } = run({ log: { fields: { TESTSIGNING: 1 } } })); await assert.rejects(p, /refused: .*TESTSIGNING/);
  ({ p } = run({ script: [{ status: 200, body: { mode: "hv-node", nonce: "00".repeat(32), session: "ab".repeat(24), keys: {} } }] })); await assert.rejects(p, /refused: the relay answered for another nonce/);
  ({ p } = run({ script: [{ status: 200, body: { mode: "avf", nonce: "00".repeat(32) } }] })); await assert.rejects(p, /refused: .*not an Enclave Shield host/);
  // roots we cannot load: no check is started at all
  const s2 = standIn(world);
  await assert.rejects(createShieldHostChecker({ relay: "https://api.test", ekRoots: () => { throw new Error("Shield app policy file missing: /x"); }, fetchImpl: s2.fetchImpl }).session("nucbox-test"), /policy file missing/);
  assert.equal(s2.calls.length, 0);
});

test("shield session: busy, re-attaching, rate-limited and momentarily-absent answers are waited out (>= 20 s, >= retryAfter, jittered), bounded; other failures are not retried", { skip: !haveOpenssl && "openssl absent" }, async () => {
  const busy = { status: 503, body: { error: "busy", message: "a fresh attestation is already in flight for this box" } };
  const reattach = { status: 503, body: { error: "busy", message: "the box is re-attaching; retry in a few seconds", retryAfter: 5 } };
  const gap = { status: 503, body: { error: "busy", message: "this box was checked moments ago; retry in 37 s", retryAfter: 37 } };
  let s = standIn(world, { script: [reattach, gap, { status: 429, body: { error: "rate_limited" } }] }), c = clock();
  const r = await checker(world, s, c).session("nucbox-test");
  assert.equal(r.verdict.admissible, true);
  // after each refusal: >= 20 s plus jitter (random 0.5 of 10 s), >= the relay's retryAfter; and the 20 s spacing holds
  assert.deepEqual(c.slept.filter((ms) => ms >= 20_000).slice(0, 3), [25_000, 42_000, 25_000]);
  for (const ms of c.slept) assert.ok(ms >= 500, `${ms}`);
  assert.equal(s.calls.filter((x) => x.url.endsWith("/attestation")).length, 4);
  // bounded: still busy after the last attempt -> unavailable (the verifier's side), and 4 attempts by default
  s = standIn(world, { script: [busy, busy, busy, busy, busy] }); c = clock();
  await assert.rejects(checker(world, s, c).session("nucbox-test"), /^Error: Shield host session unavailable: TPM keys: HTTP 503 a fresh attestation/);
  assert.equal(s.calls.length, 4);
  // a box not attached right now (a re-attach drops the old tunnel) is busy too; a 504 or 502 is not retried
  assert.equal(relayBusy(404, { error: "no_box" }), true); assert.equal(relayBusy(404, { error: "not_found" }), false); assert.equal(relayBusy(504, {}), false);
  s = standIn(world, { script: [{ status: 504, body: { error: "timeout", message: "the host did not send its TPM keys within 20 s" } }] }); c = clock();
  await assert.rejects(checker(world, s, c).session("nucbox-test"), /unavailable: TPM keys: HTTP 504/); assert.equal(s.calls.length, 1);
  assert.equal(backoffMs({ retryAfter: undefined, minBackoffMs: 20_000, jitterMs: 10_000, random: () => 0 }), 20_000);
  assert.equal(backoffMs({ retryAfter: 90, minBackoffMs: 20_000, jitterMs: 10_000, random: () => 0.999 }), 99_990);
});

test("shield session: one check per box at a time, and >= 20 s between checks of one box (other boxes are not held)", { skip: !haveOpenssl && "openssl absent" }, async () => {
  const s = standIn(world), c = clock();
  const k = checker(world, s, c);
  const [a, b] = await Promise.all([k.session("nucbox-test"), k.session("nucbox-test")]);
  assert.equal(a.verdict.admissible && b.verdict.admissible, true);
  assert.ok(b.atMs - a.atMs >= 20_000, `${b.atMs - a.atMs}`); assert.equal(s.calls.length, 4);
  assert.throws(() => k.session("../x"), /box name/);
  assert.equal(shieldBoxName({ endpoint: "https://api.enclave.host/t/nucbox-k11-4" }), "nucbox-k11-4");
  assert.equal(shieldBoxName({ endpoint: "https://x.test/t/a", name: "b" }), "b");
});

test("shield availability: spare = floor(nodeGflops x min(cpuShareFree, maxShare)) (k11-4 states no cpuGflopsFree); missing fields refuse", () => {
  // k11-4's /availability, 2026-10-16: nodeGflops 332, cpuShareFree = maxShare = 0.20999999999999996
  assert.deepEqual(shieldAvailability({ nodeGflops: 332, cpuShareFree: 0.20999999999999996, maxShare: 0.20999999999999996 }), { nodeGflops: 332, cpuGflopsFree: 69 });
  assert.deepEqual(shieldAvailability({ nodeGflops: 332, cpuShareFree: 0.9, maxShare: 0.2 }), { nodeGflops: 332, cpuGflopsFree: 66 });
  assert.deepEqual(shieldAvailability({ nodeGflops: 332, cpuShareFree: 0.05, maxShare: 0.2 }), { nodeGflops: 332, cpuGflopsFree: 16 });
  assert.deepEqual(shieldAvailability({ nodeGflops: 332, cpuShareFree: -1, maxShare: 0.2 }), { nodeGflops: 332, cpuGflopsFree: 0 });
  assert.throws(() => shieldAvailability({ nodeGflops: 332, cpuGflopsFree: 50 }), /lacks/);
});

test("shield policy: our pinned copy loads (the installer's admitted policy), and a missing, unpinned or malformed file refuses", () => {
  const file = POLICY_FILE.pathname, bytes = fs.readFileSync(file);
  const p = shieldPolicyLoader({ file, sha256: hex(sha(bytes)) })();
  assert.equal(p.schema, "enclave-shield-app-policy/1"); assert.equal(p.cpu.runtimeId, "297b6c2c0aee68c38ed612972afd11b12865e21ee39c01f4336e8721b3ef02f8");
  assert.throws(() => shieldPolicyLoader({ file: "/nonexistent/policy.json" })(), /^Error: Shield app policy file missing/);
  assert.throws(() => shieldPolicyLoader({ file, sha256: "00".repeat(32) })(), /^Error: Shield app policy file is not the pinned sha256/);
  assert.throws(() => shieldPolicyLoader({ file, readFile: () => Buffer.from("{}") })(), /^Error: Shield app policy file is not an enclave-shield-app-policy/);
});

const DEP = "0x" + "d1".repeat(32), HOSTID = "0x" + "2f".repeat(32), REF = "catalog://0x" + "96".repeat(32) + "/0", EKS = "5e".repeat(32);
const POLICY = { schema: "enclave-shield-app-policy/1", ekRoots: "pem", cpu: { runtimeId: "29".repeat(32), secretsV1: true, configBundleV5: true } };
const JOB = { id: "0x" + "33".repeat(32), deployment: { id: DEP }, offer: { hostId: HOSTID, hardwareId: shieldHardwareId(EKS) } };
const ROW = { id: DEP, active: true, isPublic: true, runner: HOSTID, appRef: REF, configCid: "", cpuMilli: 100, gpuMilli: 0 };
function loader(o = {}) {
  const order = [], derived = [];
  const load = createShieldExpectations({
    readRow: async (id) => { order.push("row"); return o.row === undefined ? { ...ROW, id } : o.row; },
    readCatalog: "cat", readConfig: "cfg", fetchVerified: "fv", policy: () => o.policy || POLICY, appRef: REF,
    expect: async (row, opts) => { order.push("derive"); derived.push({ row, opts }); if (o.expectThrows) throw new Error(o.expectThrows);
      return { appSha256: "a7".repeat(32), runtimeId: (o.policy || POLICY).cpu.runtimeId, requiresConfigBundleV5: true, requiresSecretsV1: true, requiresConfigSocketServer: false }; },
    hostSession: async (job) => { order.push("session"); return { session: { evidence: {} }, atMs: 1234, ekCertSha256: o.ek || EKS }; } });
  return { load, order, derived };
}
test("shield expectations: our ledger read and derivation (secrets required, our policy), cached per job; the host session LAST and every time; the shape verified-http needs", async () => {
  const l = loader();
  const e = await l.load(JOB);
  assert.deepEqual(e, { kind: "shield", deploymentId: DEP, hostId: HOSTID, appId: "a7".repeat(32), runtimeId: POLICY.cpu.runtimeId, origin: `https://${DEP.slice(2, 10)}.app.enclave.host/`,
                        hostSession: { evidence: {} }, hostSessionAtMs: 1234, policy: POLICY, requiresConfigBundleV5: true, requiresSecretsV1: true, requiresConfigSocketServer: false });
  assert.equal(l.derived[0].opts.secretsRequired, true); assert.equal(l.derived[0].opts.policy, POLICY);
  assert.deepEqual([l.derived[0].opts.readCatalog, l.derived[0].opts.readConfig, l.derived[0].opts.fetchVerified], ["cat", "cfg", "fv"]);
  await l.load(JOB);
  assert.deepEqual(l.order, ["row", "derive", "session", "session"], "derived once per job, a fresh session each time, always last");
  l.load.forget(DEP); await l.load(JOB); assert.equal(l.order.filter((x) => x === "derive").length, 2);
});
test("shield expectations refuse: a row not active/public, leased elsewhere, another app; a failed derivation (verifier side); another TPM than the offer's hardware (host side)", async () => {
  for (const [row, re] of [[null, /no such deployment/], [{ ...ROW, isPublic: false }, /active and public/], [{ ...ROW, active: false }, /active and public/],
                           [{ ...ROW, runner: "0x" + "44".repeat(32) }, /not leased to the offered host/], [{ ...ROW, appRef: "catalog://0x" + "55".repeat(32) + "/0" }, /reviewed audit app/]]) {
    const l = loader({ row });
    await assert.rejects(l.load(JOB), (e) => /^Shield expectation unavailable: /.test(e.message) && re.test(e.message), String(re));
    assert.ok(!l.order.includes("session"), "no TPM session for a job we cannot derive");
  }
  await assert.rejects(loader({ expectThrows: "catalog component could not be CID-verified" }).load(JOB), /^Error: Shield expectation unavailable: catalog component could not be CID-verified/);
  await assert.rejects(loader({ ek: "77".repeat(32) }).load(JOB), /^Error: Shield host session refused: the TPM is not the hardware the job was offered for/);
});

// a raw-codec CIDv1 (b + base32(0x01 0x55 0x12 0x20 || sha256))
const rawCid = (bytes) => { const b = Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), sha(bytes)]); const A = "abcdefghijklmnopqrstuvwxyz234567"; let bits = 0, v = 0, s = "b";
  for (const x of b) { v = (v << 8) | x; bits += 8; while (bits >= 5) { s += A[(v >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) s += A[(v << (5 - bits)) & 31]; return s; };
test("raw-CID fetcher: bytes accepted only when sha256 equals the CID's digest; a lying gateway is skipped; other CIDs and oversize refused", async () => {
  const good = Buffer.from("the component"), cid = rawCid(good), urls = [];
  const fetchImpl = async (url) => { urls.push(url); return new Response(url.startsWith("https://liar") ? Buffer.from("tampered") : good, { status: 200 }); };
  const f = rawCidFetcher({ gateways: ["https://liar.test", "https://good.test/"], fetchImpl });
  const r = await f(cid, 1024);
  assert.equal(r.ok, true); assert.ok(r.bytes.equals(good)); assert.deepEqual(urls, [`https://liar.test/ipfs/${cid}`, `https://good.test/ipfs/${cid}`]);
  assert.equal((await f("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG", 1024)).ok, false);
  assert.match((await rawCidFetcher({ gateways: ["https://good.test"], fetchImpl })(cid, 4)).reason, /larger than allowed/);
});

test("verified-http Shield branch: the requires* flags reach the app policy (an image without secrets support is not admitted), a busy guest is retried with the SAME nonce, the rejection carries its reason, prepare runs the loader before the request", async () => {
  const exp = { kind: "shield", deploymentId: DEP, hostId: HOSTID, appId: "a7".repeat(32), runtimeId: "29".repeat(32), origin: "https://d1d1d1d1.app.enclave.host/",
                hostSession: { evidence: {} }, hostSessionAtMs: 1_000, policy: POLICY, requiresConfigBundleV5: true, requiresSecretsV1: true, requiresConfigSocketServer: false };
  const job = { deployment: { id: DEP }, offer: { hostId: HOSTID } };
  const nonces = [], seen = []; let loads = 0, busyLeft = 2;
  const transport = async (url) => {
    if (url.pathname === "/.well-known/enclave-attestation") {
      nonces.push(url.searchParams.get("nonce"));
      if (busyLeft-- > 0) throw Object.assign(new Error("HTTP 500"), { status: 500, text: "attestation busy; retry" });
      return { body: { format: "windows-vbs-app/v1" }, spki: Buffer.from("spki") };
    }
    return { body: { digest: "x" } };
  };
  const sleep = async () => {};
  const req = verifiedAppRequest({ loadExpectations: async () => { loads++; return exp; }, now: () => 2_000, transport, sleep,
                                   verifyShield: (input, policy) => { seen.push({ input, policy }); return { ok: true }; } });
  await req.prepare(job);
  const out = await req(job, { method: "POST", path: "/v1/run", body: {}, timeoutMs: 60_000 });
  assert.equal(loads, 1, "the prepared expectation is used, not reloaded"); assert.equal(out.attestationVerified, true);
  assert.equal(nonces.length, 3); assert.equal(new Set(nonces).size, 1, "the same nonce on every retry");
  assert.deepEqual([seen[0].input.requiresConfigBundleV5, seen[0].input.requiresSecretsV1, seen[0].input.requiresConfigSocketServer], [true, true, false]);
  assert.equal(seen[0].input.hostSession, exp.hostSession); assert.equal(hex(seen[0].input.nonce), nonces[0]); assert.equal(seen[0].policy, POLICY);
  // the real app policy: an admitted image for the runtime WITHOUT secrets support is not a candidate for an app with secrets
  const real = JSON.parse(fs.readFileSync(POLICY_FILE, "utf8"));
  const noSecrets = { ...real, images: real.images.filter((i) => i.runtimeId === real.cpu.runtimeId && !i.secretsV1) };
  assert.ok(noSecrets.images.length >= 1);
  const strict = verifiedAppRequest({ loadExpectations: async () => ({ ...exp, runtimeId: real.cpu.runtimeId, policy: noSecrets }), now: () => 2_000, transport, sleep });
  await assert.rejects(strict(job, { method: "POST", path: "/v1/run", body: {}, timeoutMs: 60_000 }), /^Error: Shield app evidence rejected: runtime has no admitted image/);
  const lax = verifiedAppRequest({ loadExpectations: async () => ({ ...exp, runtimeId: real.cpu.runtimeId, policy: noSecrets, requiresSecretsV1: false, requiresConfigBundleV5: false }), now: () => 2_000, transport, sleep });
  await assert.rejects(lax(job, { method: "POST", path: "/v1/run", body: {}, timeoutMs: 60_000 }), (e) => /^Shield app evidence rejected: /.test(e.message) && !/runtime has no admitted image/.test(e.message));
  // a guest that stays busy fails as HTTP 500 after its bounded retries; a stale host session is refused before any verdict
  busyLeft = 100; nonces.length = 0;
  await assert.rejects(req(job, { method: "POST", path: "/v1/run", body: {}, timeoutMs: 60_000 }), /HTTP 500/); assert.equal(nonces.length, 6);
  busyLeft = 0;
  const stale = verifiedAppRequest({ loadExpectations: async () => ({ ...exp, hostSessionAtMs: 2_000 - 30_001 }), now: () => 2_000, transport, sleep, verifyShield: () => ({ ok: true }) });
  await assert.rejects(stale(job, { method: "POST", path: "/v1/run", body: {}, timeoutMs: 60_000 }), /^Error: current authenticated host session required/);
});

test("workload: requestVerified.prepare runs after the reference and before the timed request; a short lease discards it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-reference-"));
  try {
    const binary = path.join(dir, "reference"), body = { digest: "reference", rounds: 1, memory_bytes: 0, passes: 1 };
    fs.writeFileSync(binary, "#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on(\"end\",()=>console.log(" + JSON.stringify(JSON.stringify(body)) + "));\n", { mode: 0o700 });
    const job = { token: "t", offer: { hostId: "host", durationSec: 2n }, deployment: { id: "deployment" }, lease: { leaseUntil: BigInt(Math.floor(Date.now() / 1000) + 60) } };
    const order = [];
    const requestVerified = async () => { order.push("request"); return { body, hostId: "host", deploymentId: "deployment", attestationVerified: true }; };
    requestVerified.prepare = async () => { order.push("prepare"); await new Promise((r) => setTimeout(r, 1200)); };
    requestVerified.discard = () => order.push("discard");
    const w = createCpuWorkload({ referenceBinary: binary, requestVerified, rounds: 1, memoryMiB: 0, passes: 1, timeoutMs: 1000 });
    const r = await w.runAndVerify(job);
    assert.equal(r.verified, true, "a slow prepare (1.2 s) is not charged against the 1 s challenge"); assert.deepEqual(order, ["prepare", "request"]);
    order.length = 0;
    await assert.rejects(w.runAndVerify({ ...job, lease: { leaseUntil: 0n } }), /paid lease/); assert.deepEqual(order, ["prepare", "discard"]);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
