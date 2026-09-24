// Independent review of the pVM owner's REPEAT Pixel 10 activation run, the one with raw evidence capture (d12e78c9's
// carrier), copied verbatim into test/fixtures/verifier/pvm-client-activation-device-2 with SOURCES.json and pinned in
// verifier/integration/fixtures.json. The nine checks made for a7d624c2 (test/verifier-pvm-client-device-activation.test.mjs)
// are repeated here at the same strictness over the second run; then every recorded /evidence exchange is re-verified
// offline through the exact pinned adapter with the expectations of the policy COMMITTED before it, gated as the
// installed client gates, and correlated with the run label (the owner's map and the nonce), the client's own verified
// summary (transport key, app key, nonce, app, runtime, code hash), the exchange's UTC time, and the committed serial,
// policy key and active record after that call (exchanges.jsonl) against the generation log. A failing exchange is a
// failure with the adapter's reasons; nothing is weakened. Stream authenticity stays scoped: the client's FIN plus the
// VM's served count plus the per-nonce match; no stream secret is replayed (the installed CLI records none). The control
// case runs on the earlier real v2 envelope so the re-verification path is known to work before the results land.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, verify as edVerify, createPublicKey } from "node:crypto";
import { verifyClientPolicy, keyFingerprint } from "../verifier/pvm-policy.mjs";
import { loadOwnerModule, STRICT_INTEGRATION, verifyPvmEvidence } from "../verifier/pvm-evidence.mjs";
import { readExchanges, reverifyExchange, expectFromPolicy } from "./helpers/pvm-device-evidence.mjs";

const ownerMod = await loadOwnerModule();
const skipOwner = !ownerMod && !STRICT_INTEGRATION && "owner module absent (ENCLAVE_PVM_MODULE via verifier/integration/resolve.mjs)";
const F = new URL("./fixtures/verifier/pvm-client-activation-device-2/", import.meta.url).pathname;
const haveFixture = fs.existsSync(path.join(F, "SOURCES.json"));
if (STRICT_INTEGRATION && !haveFixture) throw new Error("strict integration: the repeat device run's fixture (pvm-client-activation-device-2) is missing");
const skip = (!haveFixture && "the repeat device run's results are not on this branch yet") || skipOwner;
const REPO = path.resolve(F, "..", "..", "..", "..");
const rd = (n) => fs.readFileSync(path.join(F, n));
const js = (n) => JSON.parse(rd(n).toString());
const lines = (label) => rd(`${label}.jsonl`).toString().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
const rc = (label) => Number(rd(`${label}.rc`).toString().trim());
const result = (label) => lines(label).find((l) => l.result)?.result ?? null;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const PINS = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "integration", "pins.json"), "utf8")), NEXT = JSON.parse(fs.readFileSync(path.join(REPO, "verifier", "integration", "next-builds.json"), "utf8"));
const SRC = haveFixture ? js("SOURCES.json") : null;
const NOW = haveFixture ? Date.parse(JSON.parse(Buffer.from(js("policies/policy-1.json").policy, "base64").toString()).notBefore) + 3600e3 : 0;
const keys = haveFixture ? { policy: js("policy-key.json"), release: js("release-key.json"), successor: js("successor-key.json") } : null;
const anchor = haveFixture ? js("cli-install.json").anchor : null;
const gen = (n) => js(`cli-state.d/${n}.json`);
const state = (snap) => js(`state-${snap}.json`);
const staged = (snap) => js(`staged-${snap}.json`);
const inode = (snap, name) => { for (const l of rd(`install-${snap}.txt`).toString().split("\n")) { const p = l.split(" "); if (p.length === 4 && p[3] === name) return { inode: +p[0], size: +p[1], mode: p[2] }; } return null; };
const policyBytes = (n) => Buffer.from(js(`policies/${n}.json`).policy, "base64");
const policyBody = (n) => JSON.parse(policyBytes(n).toString());
const spki = (rawHex) => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(rawHex, "hex")]), format: "der", type: "spki" });
const V = "0.3.1", BASE_SHA = PINS["pvm-client-dist"].files["shielded/anchor/avf/client/dist/pvm-client.mjs"], BASE_COMMIT = PINS["pvm-client-dist"].commit;
const NX = haveFixture ? js("lab-next.json") : { sha256: "", size: 0, base: {} }, REC = { version: V, sha256: NX.sha256, size: NX.size, file: `pvm-client-${V}-${NX.sha256}.mjs`, sourceCommit: BASE_COMMIT };
const ACTIVE_RUNS = ["active-stream", "active-whole", "planted-marker", "active-policy-2", "rotate-3", "successor-4", "retired-5", "repaired-stream", "repaired-2-stream", "rollback"];

test("repeat: the fixture is the owner's results verbatim: every file hashes to SOURCES.json, and the five hashes the owner reported match", { skip }, () => {
  for (const [rel, want] of Object.entries(SRC.files)) assert.equal(sha256(rd(rel)), want, rel);
  for (const [rel, want] of Object.entries(SRC.ownerReportedSha256)) assert.equal(sha256(rd(rel)), want, `owner-reported ${rel}`);
  assert.ok(Object.keys(SRC.files).length >= 137 + 10 * 3 + 2, "the second run carries every first-run file plus the evidence pairs, their meta, exchanges.jsonl and capture.json");
});
test("repeat: artifact identity: the activated 0.3.1 is this branch's reproduced derivation of the pinned 0.3.0 dist, and both manifests name exactly it", { skip }, () => {
  assert.equal(NX.base.sha256, BASE_SHA, "derived from the pinned dist"); assert.equal(NX.base.version, "0.3.0");
  assert.equal(NX.sha256, NEXT.derived[V].sha256, "the same bytes this branch reproduced (next-builds.json)"); assert.equal(NX.size, NEXT.derived[V].size);
  assert.equal(NEXT.base, BASE_COMMIT);
  for (const [n, countersigner] of [["manifest-0.3.1", keys.policy], ["manifest-0.3.1-rotated", keys.successor]]) {
    const env = js(`${n}.json`), mb = Buffer.from(env.manifest, "base64"), m = JSON.parse(mb.toString());
    assert.deepEqual({ type: m.type, artifact: m.artifact, version: m.version, artifactSha256: m.artifactSha256, size: m.size, sourceCommit: m.sourceCommit, nextReleaseKey: m.nextReleaseKey },
                     { type: "enclave-pvm-client-update", artifact: "pvm-client.mjs", version: V, artifactSha256: NX.sha256, size: NX.size, sourceCommit: BASE_COMMIT, nextReleaseKey: null }, n);
    assert.equal(m.releaseKey, keys.release.key); assert.equal(m.policyKey, countersigner.key);
    assert.equal(edVerify(null, Buffer.concat([Buffer.from("enclave-pvm-client-update-v1\n"), mb]), spki(m.releaseKey), Buffer.from(env.releaseSig, "hex")), true, `${n}: release signature`);
    assert.equal(edVerify(null, Buffer.concat([Buffer.from("enclave-pvm-client-update-countersign-v1\n"), mb]), spki(m.policyKey), Buffer.from(env.policySig, "hex")), true, `${n}: policy countersignature`);
    assert.equal(edVerify(null, Buffer.concat([Buffer.from("enclave-pvm-client-update-countersign-v1\n"), mb]), spki(n.endsWith("rotated") ? keys.policy.key : keys.successor.key), Buffer.from(env.policySig, "hex")), false, `${n}: the other policy key does not countersign it`);
    assert.ok(Date.parse(m.notAfter) > NOW);
  }
  for (const k of Object.values(keys)) assert.equal(keyFingerprint(k.key), k.fingerprint, "fingerprint = sha256 of the raw key");
  assert.equal(anchor.policyKeyFp, keys.policy.fingerprint); assert.equal(anchor.releaseKeyFp, keys.release.fingerprint); assert.equal(anchor.serialFloor, 1);
  assert.equal(js("tampered.json").sha256 !== NX.sha256 && js("tampered.json").size === NX.size + 63, true, "the tampered bytes are other bytes (one appended line)");
});
test("repeat: the generation log: 7 generations, monotonic serial, digests equal to the accepted policies' bytes, release key constant, staged then active equal to the signed record, rotation recorded, nothing ever moved back", { skip }, () => {
  const g = [1, 2, 3, 4, 5, 6, 7].map(gen);
  g.forEach((x, i) => assert.equal(x.gen, i + 1));
  const s = g.map((x) => x.state);
  assert.deepEqual(s[0], { policyFp: keys.policy.fingerprint, nextPolicyFp: null, serial: 1, digest: null, releaseFp: keys.release.fingerprint, nextReleaseFp: null, staged: null, active: null }, "install");
  for (let i = 1; i < s.length; i++) { assert.ok(s[i].serial >= s[i - 1].serial, `serial never decreases (gen ${i + 1})`); assert.equal(s[i].releaseFp, keys.release.fingerprint); assert.equal(s[i].nextReleaseFp, null); }
  assert.equal(s[1].digest, sha256(policyBytes("policy-1"))); assert.equal(s[1].serial, 1);                        // gen 2: policy 1 accepted (serial equal to the floor, digest recorded)
  assert.deepEqual(s[2].staged, REC); assert.equal(s[2].active, null); assert.equal(s[2].digest, s[1].digest);       // gen 3: staged, nothing else changed
  assert.deepEqual(s[3].active, REC); assert.deepEqual(s[3].staged, REC); assert.equal(s[3].serial, 1);            // gen 4: activated == staged
  assert.equal(s[4].serial, 2); assert.equal(s[4].digest, sha256(policyBytes("policy-2")));                           // gen 5: policy 2 by the delegated client
  assert.equal(s[5].serial, 3); assert.equal(s[5].digest, sha256(policyBytes("rotate-3"))); assert.equal(s[5].nextPolicyFp, keys.successor.fingerprint); assert.equal(s[5].policyFp, keys.policy.fingerprint);
  assert.equal(s[6].serial, 4); assert.equal(s[6].digest, sha256(policyBytes("successor-4"))); assert.equal(s[6].policyFp, keys.successor.fingerprint); assert.equal(s[6].nextPolicyFp, null);
  for (const x of s.slice(3)) { assert.deepEqual(x.active, REC, "active kept by every later commit"); assert.deepEqual(x.staged, REC, "staged kept"); }
  assert.equal(fs.existsSync(path.join(F, "cli-state.d", "8.json")), false, "no generation after the rotation: no refusal, repair or rollback attempt committed anything");
});
test("repeat: snapshots: activation added exactly one generation; from the rotation on, every snapshot (tamper, refused repairs, repairs, missing, rollback, final) is generation 7 with the same state", { skip }, () => {
  assert.equal(state("1-staged").gen, 3); assert.equal(state("2-activated").gen, 4); assert.equal(js("activate.jsonl").activate.gen, 4);
  assert.deepEqual(js("activate.jsonl").activate, { ok: true, version: V, sha256: NX.sha256, gen: 4 }); assert.equal(rc("activate"), 0);
  const ref = state("3b-rotated"); assert.equal(ref.gen, 7); assert.deepEqual(ref.state, gen(7).state);
  for (const snap of ["4-tampered", "5-tampered-after", "6-repaired", "7-missing", "8-repaired-2", "9-final"]) assert.deepEqual(state(snap), ref, snap);
  assert.deepEqual(staged("2-activated").active, { ...REC, path: staged("2-activated").active.path, bytesMatch: true }); assert.equal(rc("staged-2-activated"), 0);
});
test("repeat: the six policies replayed with this session's verifier, under the anchor and the rollback memory the state names, give the device's outcomes", { skip }, () => {
  const opts = (o) => ({ anchorFp: anchor.policyKeyFp, serialFloor: anchor.serialFloor, now: NOW, clientVersion: V, ...o });
  const env = (n) => js(`policies/${n}.json`);
  const p1 = verifyClientPolicy(env("policy-1"), opts({})); assert.equal(p1.ok, true, p1.reason);
  const p2 = verifyClientPolicy(env("policy-2"), opts({ state: { serial: 1, digest: sha256(policyBytes("policy-1")) } })); assert.equal(p2.ok, true, p2.reason);
  const p3 = verifyClientPolicy(env("rotate-3"), opts({ state: { serial: 2, digest: sha256(policyBytes("policy-2")) } })); assert.equal(p3.ok, true, p3.reason);
  assert.equal(policyBody("rotate-3").nextPolicyKey, keys.successor.key, "policy 3 names the successor key");
  const p4 = verifyClientPolicy(env("successor-4"), opts({ anchorFp: keys.successor.fingerprint, state: { serial: 3, digest: sha256(policyBytes("rotate-3")) } })); assert.equal(p4.ok, true, p4.reason);
  assert.match(verifyClientPolicy(env("successor-4"), opts({ state: { serial: 3, digest: sha256(policyBytes("rotate-3")) } })).reason, /does not name/, "under the original anchor alone the successor's policy is a stranger: the rotation is what admits it");
  const p5 = verifyClientPolicy(env("retired-5"), opts({ anchorFp: keys.successor.fingerprint, state: { serial: 4, digest: sha256(policyBytes("successor-4")) } })); assert.equal(p5.ok, false); assert.match(p5.reason, /does not name/);
  const pr = verifyClientPolicy(env("rollback-3"), opts({ anchorFp: keys.successor.fingerprint, state: { serial: 4, digest: sha256(policyBytes("successor-4")) } })); assert.equal(pr.ok, false); assert.match(pr.reason, /rollback/);
  // the device's own outcomes for the same six
  assert.equal(result("base-stream").policySerial, 1); assert.equal(result("active-policy-2").policySerial, 2); assert.equal(result("rotate-3").policySerial, 3); assert.equal(result("successor-4").policySerial, 4);
  assert.equal(result("retired-5").step, "policy"); assert.match(result("retired-5").refused, /anchor does not name/); assert.equal(result("retired-5").sent, false); assert.equal(rc("retired-5"), 1);
  assert.equal(result("rollback").step, "policy"); assert.match(result("rollback").refused, /serial 3 is below the 4 .*rollback/); assert.equal(result("rollback").sent, false);
  for (const n of ["policy-1", "policy-2", "rotate-3", "successor-4", "retired-5", "rollback-3"]) { const b = policyBody(n); assert.deepEqual([b.codeHashes, b.runtimeIds, b.formats], [["433dd3dfa08f5be8d77cefcc93cd5297acdf022d7fa9dfc9d584fe081f1c0dfd"], ["d3370878afa9d5ee064cdcd9c50572a6baa8e23de35f5f4a0c41b7ec8f80acba"], ["enclave-pvm-app-evidence/v2"]], n); }
});
test("repeat: running identity and order: before activation 0.3.0 answers; after it every answered run is 0.3.1 (ten results, the checker's hand count of nine was the miscount), each delegated run committed its policy before its evidence request, and each verified summary names the policy's pins", { skip }, () => {
  for (const l of ["base-stream", "staged-not-active"]) { const r = result(l); assert.equal(r.clientVersion, "0.3.0", l); assert.equal(r.complete, true); assert.equal(r.tokens, 24); assert.equal(r.status, 200); }
  assert.equal(lines("staged-not-active")[0].committed?.serial, 1, "staging runs nothing: the launcher itself committed and ran");
  const after = ACTIVE_RUNS.map((l) => result(l));
  assert.equal(after.length, 10); assert.equal(after.every((r) => r && r.clientVersion === V), true, "all ten post-activation results carry 0.3.1");
  assert.equal(after.filter((r) => r.step === "policy").length, 2, "two of them are policy refusals (retired-5, rollback), which the run's first checker did not count");
  const c0 = rd("check.txt").toString();
  assert.match(c0, /^ok   after activation every answered run was 0\.3\.1, never 0\.3\.0 \(10 results, want 10\)$/m, "the corrected count rule");
  assert.match(c0, /^ok   the relay recorded one raw v2 evidence envelope per exchange, each answering the nonce the client sent \(10, want 10\)$/m);
  assert.match(c0, /^PASS /m, "the repeat run's own checker passed (a failure here is examined, never explained away)"); assert.equal(/^FAIL/m.test(c0), false);
  for (const [label, serial] of [["active-stream", 1], ["planted-marker", 1], ["active-policy-2", 2], ["rotate-3", 3], ["successor-4", 4], ["repaired-stream", 4], ["repaired-2-stream", 4]]) {
    const ls = lines(label), ci = ls.findIndex((l) => l.committed), ri = ls.findIndex((l) => l.result), r = ls[ri].result;
    assert.ok(ci >= 0 && ci < ri, `${label}: committed before the result`); assert.equal(ls[ci].committed.serial, serial);
    assert.equal(r.complete, true, label); assert.equal(r.tokens, 24); assert.equal(r.status, 200); assert.equal(r.policySerial, serial); assert.equal(rc(label), 0);
    assert.deepEqual({ format: r.verified.format, app: r.verified.app, runtime: r.verified.runtime, codeHash: r.verified.codeHash },
                     { format: "enclave-pvm-app-evidence/v2", app: policyBody("policy-1").appIds[0], runtime: policyBody("policy-1").runtimeIds[0], codeHash: policyBody("policy-1").codeHashes[0] }, `${label}: the verified summary names the policy's pins`);
  }
  const w = result("active-whole"); assert.equal(w.status, 200); assert.equal(w.clientVersion, V); assert.match(w.body || "", /"token":/);
  const whole = lines("active-whole"); assert.ok(whole.findIndex((l) => l.committed) < whole.findIndex((l) => l.result));
  assert.equal(result("planted-marker").clientVersion, V, "a marker planted on the launcher: it still delegated");
});
test("repeat: refusals and repairs: tamper in place (same inode), refused at launch with expected and the tampered digest as found, nothing else printed; missing: found missing; the wrong file cannot be overwritten; the retired key cannot repair; the successor's manifest re-publishes (new inode, read-only), twice", { skip }, () => {
  const tam = js("tampered.json");
  assert.equal(inode("3b-rotated", REC.file).inode, inode("4-tampered", REC.file).inode, "tampered in place"); assert.equal(inode("4-tampered", REC.file).size, tam.size); assert.equal(inode("3b-rotated", REC.file).mode, "444");
  const t = lines("tampered"); assert.equal(t.length, 1); assert.equal(rc("tampered"), 2);
  assert.deepEqual(t[0].result.expected, { version: V, sha256: NX.sha256, file: REC.file }); assert.equal(t[0].result.found, tam.sha256); assert.equal(t[0].result.sent, false); assert.equal(t[0].result.clientVersion, undefined, "the launcher's refusal, not a client result");
  assert.equal(rc("staged-4-tampered"), 1); assert.equal(staged("4-tampered").active.bytesMatch, false); assert.equal(staged("4-tampered").staged.bytesMatch, false);
  assert.match(lines("repair-refused")[0].update.reasons[0], /already exists with bytes other than its name says/); assert.equal(rc("repair-refused"), 1);
  assert.match(lines("repair-old-key")[0].update.reasons[0], /countersigned by a policy key this client's anchor does not name/); assert.equal(rc("repair-old-key"), 1);
  const r1 = lines("repair-1")[0].update; assert.deepEqual({ ok: r1.ok, version: r1.version, gen: r1.gen, already: r1.already }, { ok: true, version: V, gen: 7, already: true }); assert.equal(rc("repair-1"), 0);
  const i6 = inode("6-repaired", REC.file); assert.notEqual(i6.inode, inode("4-tampered", REC.file).inode); assert.equal(i6.size, NX.size); assert.equal(i6.mode, "444");
  assert.equal(staged("6-repaired").active.bytesMatch, true); assert.equal(rc("staged-6-repaired"), 0);
  const m = lines("missing"); assert.equal(m.length, 1); assert.equal(m[0].result.found, "missing"); assert.equal(m[0].result.step, "launch"); assert.equal(rc("missing"), 2); assert.equal(inode("7-missing", REC.file), null);
  const r2 = lines("repair-2")[0].update; assert.equal(r2.already, true); assert.equal(r2.gen, 7); assert.equal(staged("8-repaired-2").active.bytesMatch, true);
  assert.equal(inode("9-final", "pvm-client.mjs").size, 137180, "the launcher's own file untouched throughout"); assert.equal(inode("0-installed", "pvm-client.mjs").inode, inode("9-final", "pvm-client.mjs").inode);
});
test("repeat: the VM capture, decoded here: the VM served exactly the released requests (9 streams to FIN, 1 whole), and no request or token appears in the clear in the capture, the hub or the carriers", { skip }, () => {
  const decode = (t) => t + "\n" + [...t.matchAll(/APPOUT \d+ ([0-9a-f]+)/g)].map((m) => Buffer.from(m[1], "hex").toString("utf8")).join("\n");
  const L = decode(rd("l1.log").toString());
  assert.equal((L.match(/SEALED stream nonce=\w+ fin after/g) || []).length, 9); assert.equal((L.match(/SEALED served nonce=/g) || []).length, 1);
  const streams = ["base-stream", "staged-not-active", "active-stream", "planted-marker", "active-policy-2", "rotate-3", "successor-4", "repaired-stream", "repaired-2-stream"].filter((l) => result(l).complete === true).length;
  assert.equal(streams, 9, "nine client-side complete streams"); assert.equal(result("active-whole").status, 200, "one whole answer");
  // one to one: every exchange the client reports is one the VM served, by nonce; nine distinct stream nonces and the whole's
  const nonces = ["base-stream", "staged-not-active", "active-stream", "planted-marker", "active-policy-2", "rotate-3", "successor-4", "repaired-stream", "repaired-2-stream"].map((l) => result(l).verified.nonce);
  assert.equal(new Set(nonces).size, 9); for (const n of nonces) assert.ok(L.includes(`SEALED stream nonce=${n} fin after 15 chunks`), `the VM served stream ${n} to FIN`);
  assert.ok(L.includes(`SEALED served nonce=${result("active-whole").verified.nonce} (`), "the VM served the whole answer under the client's nonce");
  assert.equal([...L.matchAll(/SEALED (?:stream|served) nonce=(\w+)/g)].map((m) => m[1]).filter((n) => ![...nonces, result("active-whole").verified.nonce].includes(n)).length, 0, "the VM served nothing the client did not report");
  for (const n of ["l1.log", "hub.jsonl", "hub.err", "carrier.log", "update-carrier.log"]) { const t = decode(rd(n).toString()); for (const needle of ["GET /?graph", "steps=", '"token":', "tok_per_s"]) assert.equal(t.includes(needle), false, `${n} carries ${needle}`); }
  for (const rel of Object.keys(SRC.files)) assert.equal(rd(rel).toString("latin1").includes("PRIVATE KEY"), false, rel);
});


// ---- control: the re-verification path itself, on the earlier REAL v2 envelope (fixture pvm-evidence/l1-v2-evidence.json) --
const E = new URL("./fixtures/verifier/pvm-evidence/", import.meta.url);
const l1v2 = JSON.parse(fs.readFileSync(new URL("l1-v2-evidence.json", E), "utf8"));
const IDENTITY = { name: "wasmtime", version: "49.0.0", execution: "interpreter", targetIsa: "pulley64", hostIsa: "aarch64", cpuFeatures: "baseline", wx: "enforced", cache: "none" };
const CONTROL_POLICY = { appIds: ["1ad17b45e12aabdec8ca08538ce1d3a795a7e68c3b87d534b50305d5654ca339"], runtimeIds: [ownerMod ? ownerMod.runtimeId(IDENTITY).toString("hex") : "0".repeat(64)],
  codeHashes: ["6fab3d4c43ef6df953d5102098203c0b8db58a162172e4b92fa26df0ca598990"],
  authorityHashes: ["cd0a7823095d98f82d4787205f020a3f2784912b032eff4f4e6525bba5654df8baaa64c7bebf03ad074788db7b517d82f3c63513f5c39a381b629c26aba38c0f"],   // gitleaks:allow -- public: sha512 of the TEST APK signing certificate
  googleRootPins: ["cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc", "6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"], formats: ["enclave-pvm-app-evidence/v2"], sealedWindow: { seconds: 600, maxRequests: 256 } };
const NOW_V2 = Date.parse("2026-09-24T07:26:36Z");
test("control: the recorded-exchange path re-verifies the earlier real v2 envelope through the pinned adapter and releases a browser-kind client; the wrong committed policy, a foreign nonce, a stale clock, a malformed request and a v1 downgrade each fail loudly", { skip: skipOwner }, async () => {
  const ex = { n: "001", nonce: l1v2.nonce, requestText: `EVIDENCE ${l1v2.nonce}\n`, envelope: l1v2, envelopeText: JSON.stringify(l1v2) + "\n", parseError: null };
  const r = await reverifyExchange(ex, CONTROL_POLICY, { now: NOW_V2 });
  assert.equal(r.ok, true, r.why); assert.equal(r.summary.appKey, l1v2.appKey.slice(0, 16)); assert.equal(r.summary.key, l1v2.spki.slice(-16)); assert.equal(r.summary.nonce, l1v2.nonce.slice(0, 16));
  assert.equal(r.summary.codeHash, CONTROL_POLICY.codeHashes[0]); assert.deepEqual(r.sealed, { windowSeconds: 600, maxRequests: 256 });
  const wrongPolicy = await reverifyExchange(ex, { ...CONTROL_POLICY, codeHashes: ["0".repeat(64)] }, { now: NOW_V2 }); assert.equal(wrongPolicy.ok, false); assert.match(wrongPolicy.why, /rejected/);
  const foreign = await reverifyExchange({ ...ex, nonce: "1".repeat(64), requestText: `EVIDENCE ${"1".repeat(64)}\n` }, CONTROL_POLICY, { now: NOW_V2 }); assert.equal(foreign.ok, false); assert.match(foreign.why, /not this client's challenge/);
  const stale = await reverifyExchange(ex, CONTROL_POLICY, { now: Date.parse("2026-10-24T00:00:00Z") }); assert.equal(stale.ok, false); assert.match(stale.why, /expired|rejected/);
  const malformed = await reverifyExchange({ ...ex, requestText: "EVIDENCE nope\n", nonce: null }, CONTROL_POLICY, { now: NOW_V2 }); assert.equal(malformed.ok, false); assert.match(malformed.why, /not "EVIDENCE <nonce>"/);
  const v1 = await verifyPvmEvidence({ ...l1v2, format: "enclave-pvm-app-evidence/v1", appKey: undefined, appKeySig: undefined }, expectFromPolicy(CONTROL_POLICY, l1v2.nonce), { now: NOW_V2 }); assert.equal(v1.status, "rejected", "a v1 answer is a downgrade under a v2-only policy");
});

// ---- the exchanges: re-verified through the pinned adapter, correlated with label, summary, time and committed state ----
const ORDER = ["base-stream", "staged-not-active", "active-stream", "active-whole", "planted-marker", "active-policy-2", "rotate-3", "successor-4", "repaired-stream", "repaired-2-stream"];
const SERIAL_BEFORE = { "base-stream": 1, "staged-not-active": 1, "active-stream": 1, "active-whole": 1, "planted-marker": 1, "active-policy-2": 2, "rotate-3": 3, "successor-4": 4, "repaired-stream": 4, "repaired-2-stream": 4 };
const POLICY_OF_SERIAL = { 1: "policy-1", 2: "policy-2", 3: "rotate-3", 4: "successor-4" };
test("repeat: the capture is declared and complete: ten exchanges in the recorded order, each request a nonce line, each envelope one JSON line answering that nonce, UTC times inside the run, and the owner's exchange-to-label map consistent with the CLI rows", { skip }, () => {
  const cap = js("capture.json"); assert.equal(cap.clock, "UTC"); assert.ok(Date.parse(cap.runStart) < Date.parse(cap.runEnd));
  assert.deepEqual(cap.exchanges.map((e) => e.label), ORDER, "the label map in the exact order");
  const exs = readExchanges(path.join(F, "evidence")); assert.equal(exs.length, 10);
  const rows = rd("exchanges.jsonl").toString().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  for (const [i, ex] of exs.entries()) {
    assert.equal(ex.n, String(i + 1).padStart(3, "0")); assert.ok(ex.nonce, `${ex.n}: request line`); assert.ok(ex.envelope, `${ex.n}: envelope ${ex.parseError || ""}`);
    assert.equal(ex.envelope.nonce, ex.nonce, `${ex.n}: the envelope answers its own request's nonce`); assert.equal(ex.envelope.format, "enclave-pvm-app-evidence/v2");
    const meta = js(`evidence/evidence-${ex.n}.meta.json`); assert.equal(meta.n, i + 1);
    for (const t of [meta.sentToVmAt, meta.answeredAt]) assert.ok(Date.parse(cap.runStart) <= Date.parse(t) && Date.parse(t) <= Date.parse(cap.runEnd), `${ex.n}: ${t} inside the run`);
    assert.ok(Date.parse(meta.sentToVmAt) <= Date.parse(meta.answeredAt));
    assert.equal(meta.bytesIn, Buffer.byteLength(ex.requestText)); assert.equal(meta.bytesOut, Buffer.byteLength(ex.envelopeText));
    const label = cap.exchanges[i].label, row = rows.find((r) => r.label === label);
    assert.ok(row, `${label}: a CLI row`); assert.ok(row.exchanges.includes(i + 1) || row.exchanges.includes(ex.n), `${label}: the row names exchange ${ex.n}`);
    assert.equal(result(label).verified.nonce, ex.nonce.slice(0, 16), `${label}: the client's own nonce prefix is this exchange's`);
    assert.ok(Date.parse(row.utcStart) <= Date.parse(meta.sentToVmAt) && Date.parse(meta.answeredAt) <= Date.parse(row.utcEnd), `${label}: the exchange lies inside the call`);
  }
  assert.equal(new Set(exs.map((e) => e.nonce)).size, 10, "ten distinct nonces");
  for (const label of ["retired-5", "rollback", "tampered", "missing"]) assert.equal(rows.find((r) => r.label === label)?.exchanges?.length ?? 0, 0, `${label}: a refusal fetched no evidence`);
});
test("repeat: every exchange re-verifies offline through the pinned adapter under the policy committed before it, releases a browser-kind client, and its claims equal the client's own verified summary", { skip }, async () => {
  const cap = js("capture.json"), exs = readExchanges(path.join(F, "evidence"));
  const failures = [];
  for (const [i, ex] of exs.entries()) {
    const label = cap.exchanges[i].label, serial = SERIAL_BEFORE[label], pol = policyBody(POLICY_OF_SERIAL[serial]), meta = js(`evidence/evidence-${ex.n}.meta.json`);
    const r = await reverifyExchange(ex, pol, { now: Date.parse(meta.answeredAt) });
    if (!r.ok) { failures.push(`${ex.n} ${label} (policy serial ${serial}): ${r.why}`); continue; }
    const v = result(label).verified;
    assert.deepEqual(r.summary, { format: v.format, app: v.app, runtime: v.runtime, codeHash: v.codeHash, key: v.key, appKey: v.appKey, nonce: v.nonce }, `${ex.n} ${label}: the adapter's claims equal the client's own summary`);
    assert.deepEqual(r.sealed, { windowSeconds: pol.sealedWindow.seconds, maxRequests: pol.sealedWindow.maxRequests }, `${ex.n} ${label}: the sealed window is the policy's`);
    assert.equal(ex.envelope.app, pol.appIds[0]); assert.equal(r.verdict.claims.runtimeId, pol.runtimeIds[0]); assert.equal(r.verdict.claims.measurement, pol.codeHashes[0]);
    const stale = await reverifyExchange(ex, pol, { now: Date.parse(meta.answeredAt) + 400 * 24 * 3600e3 }); assert.equal(stale.ok, false, `${ex.n}: a clock far after the run refuses the chain`);
    const wrongPolicy = await reverifyExchange(ex, { ...pol, codeHashes: ["0".repeat(64)] }, { now: Date.parse(meta.answeredAt) }); assert.equal(wrongPolicy.ok, false, `${ex.n}: another code hash refuses`);
  }
  assert.deepEqual(failures, [], `exchanges that did not re-verify:\n${failures.join("\n")}`);
  // the ten envelopes bind ten distinct nonces but one VM boot: one transport key, one app key across the run
  assert.equal(new Set(exs.map((e) => e.envelope.spki)).size, 1, "one attested transport key: one boot"); assert.equal(new Set(exs.map((e) => e.envelope.appKey)).size, 1);
  // each envelope verifies only under its own nonce: exchange k's envelope under exchange j's request is a replay
  const swapped = await reverifyExchange({ ...exs[2], nonce: exs[3].nonce, requestText: exs[3].requestText }, policyBody("policy-1"), { now: Date.parse(js("evidence/evidence-003.meta.json").answeredAt) });
  assert.equal(swapped.ok, false); assert.match(swapped.why, /not this client's challenge/);
});
test("repeat: the committed state each exchange ran under (exchanges.jsonl 'after') equals the generation log at that generation: serial, policy key, successor, release key and active record; the client's result names the same generation", { skip }, () => {
  const cap = js("capture.json"), rows = rd("exchanges.jsonl").toString().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  for (const [i, e] of cap.exchanges.entries()) {
    const row = rows.find((r) => r.label === e.label), a = row.after, g = gen(a.gen).state, res = result(e.label);
    assert.deepEqual({ serial: a.serial, policyFp: a.policyFp, nextPolicyFp: a.nextPolicyFp, releaseFp: a.releaseFp, active: a.active ? { version: a.active.version, sha256: a.active.sha256 } : null },
                     { serial: g.serial, policyFp: g.policyFp, nextPolicyFp: g.nextPolicyFp, releaseFp: g.releaseFp, active: g.active ? { version: g.active.version, sha256: g.active.sha256 } : null }, `${e.label}: the row's 'after' is generation ${a.gen}`);
    assert.deepEqual(e.stateAfter ?? a, e.stateAfter ?? a);
    assert.equal(a.serial, SERIAL_BEFORE[e.label], `${e.label}: the serial the exchange ran under`); assert.equal(res.policySerial, a.serial); assert.equal(res.stateGen, a.gen, `${e.label}: the client reports the generation it committed`);
    const active = ["active-stream", "active-whole", "planted-marker", "active-policy-2", "rotate-3", "successor-4", "repaired-stream", "repaired-2-stream"].includes(e.label);
    assert.equal(!!a.active, active, `${e.label}: active ${active ? "set" : "null"} at that time`); if (active) assert.equal(a.active.sha256, NX.sha256);
    assert.equal(a.policyFp, ["successor-4", "repaired-stream", "repaired-2-stream"].includes(e.label) ? keys.successor.fingerprint : keys.policy.fingerprint, `${e.label}: the policy key at that time`);
    assert.equal(a.releaseFp, keys.release.fingerprint);
  }
});
test("repeat: evidence classes, as this review states them: the attestation chains of all ten exchanges are re-verified offline here through the pinned adapter; stream authenticity remains the client's FIN plus the VM's served count plus the per-nonce match, with no stream secret replayed", { skip }, () => {
  assert.equal(readExchanges(path.join(F, "evidence")).length, 10);
  assert.equal(Object.keys(SRC.files).some((f) => /trace|secret|exported/i.test(f)), false, "no stream secrets in the results");
  assert.match(rd("NOTES.md").toString(), /FIN/);
});
