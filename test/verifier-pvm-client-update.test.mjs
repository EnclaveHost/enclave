// Update staging and key rotation, black-box against the BUILT 0.2.0 CLI (pin pvm-client-dist): manifests signed by the
// lab release key and countersigned by the lab policy key as the design text defines; artifact downloads held by the lab
// carrier as barriers. Cases: a valid update stages; one key alone is refused; two stagers of different versions in both
// completion orders (the older can never replace the newer); a policy-key rotation by a signed nextPolicyKey, after which
// the retired key's policies and a rollback under it are refused; the update's release-key rotation and a policy commit in
// both orders, neither losing the other's fields; and a storm of concurrent updates and policy commits whose final state
// is fixed by the monotonic rules whatever the interleaving.
//   run: ENCLAVE_PVM_CLIENT_CLI=<pinned pvm-client.mjs> [ENCLAVE_PVM_CLIENT_F2_CLI=<0.2.0 pvm-client.mjs>] node --test test/verifier-pvm-client-update.test.mjs
// Lab versions are above the pinned client's own (0.2.1 at e7a2badc): a manifest not newer than it is refused by design.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { labServer, keys, signedPolicy, signedManifest, fakeArtifact, rawPub, fpOf, sha256, APP, cliRun, cliSync, committedState, install } from "./helpers/pvm-lab.mjs";

const CLI = process.env.ENCLAVE_PVM_CLIENT_CLI || "";
const STRICT = process.env.ENCLAVE_STRICT_INTEGRATION === "1";
if (STRICT && !(CLI && fs.existsSync(CLI))) throw new Error("strict integration: ENCLAVE_PVM_CLIENT_CLI (the built client, pinned as pvm-client-dist) is missing");
const skip = !(CLI && fs.existsSync(CLI)) && !STRICT && "built client absent";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pvm-update-"));
const K = keys();
let L, V, VF2;   // the lab; the pinned client's own version and the pre-fix build's, read from `version`: lab versions sit above them
const own = (cli) => cliSync(cli, tmp, ["version"]).lines.find((l) => l.version)?.version;
const v = (k, patch = 0) => { const [a, b] = String(V).split(".").map(Number); return `${a}.${b + k}.${patch}`; };
const esc = (x) => x.replace(/\./g, "\\.");
test.before(async () => { L = await labServer(); if (!skip) V = own(CLI); if (!skipF2) VF2 = own(F2); });
test.after(() => { L?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
const dirFor = (n) => { const d = path.join(tmp, n); fs.mkdirSync(path.join(d, "install"), { recursive: true }); return { state: path.join(d, "state.d"), install: path.join(d, "install") }; };
const update = (d, manifest, artifact = manifest) => cliRun(CLI, tmp, ["update", "--manifest", `${L.base}/manifest/${manifest}`, "--artifact", `${L.base}/artifact/${artifact}`, "--state", d.state, "--install-dir", d.install]);
const run = (d, policy, label) => cliRun(CLI, tmp, ["run", "--policy", `${L.base}/policy/${policy}`, "--relay", `${L.base}/r/${label}`, "--app", APP, "--state", d.state, "--label", label]);
const staged = (d) => cliSync(CLI, tmp, ["staged", "--state", d.state, "--install-dir", d.install]).lines.find((l) => "staged" in l)?.staged ?? null;
const put = (name, version, opts = {}) => { const bytes = fakeArtifact(version); L.artifacts.set(name, { bytes, hold: !!opts.hold }); L.manifests.set(name, signedManifest(K, version, bytes, opts)); return bytes; };
const runToEvidence = async (d, policy, label) => { const r = run(d, policy, label); await L.evidenceRequested(label); L.release(label); return r.done; };

test("a release-signed, policy-countersigned manifest stages its exact bytes beside the client, and the state records it", { skip }, async () => {
  const d = dirFor("u1"); install(CLI, tmp, d.state, K);
  const bytes = put("u1", v(1));
  const r = await update(d, "u1").done; assert.equal(r.status, 0, r.out + r.err); assert.equal(r.update?.version, v(1));
  const s = staged(d); assert.equal(s?.version, v(1)); assert.equal(s?.bytesMatch, true); assert.equal(s?.sha256, sha256(bytes));
  assert.equal(committedState(CLI, tmp, d.state)?.staged?.version, v(1));
  fs.rmSync(s.path); fs.writeFileSync(s.path, Buffer.concat([bytes, Buffer.from("\n// tampered\n")]));   // the staged file replaced on disk
  assert.equal(staged(d)?.bytesMatch, false, "`staged` reports bytes that no longer match the committed digest");
});
test("one key alone cannot ship code: a wrong countersignature, or a stranger's release key, is refused and nothing is staged", { skip }, async () => {
  const d = dirFor("u2"); install(CLI, tmp, d.state, K);
  const bytes = fakeArtifact(v(1)); L.artifacts.set("u2", { bytes });
  const good = signedManifest(K, v(1), bytes);
  L.manifests.set("u2", { ...good, policySig: signedManifest(K, v(1), bytes, { policyKey: K.other }).policySig });
  const r1 = await update(d, "u2").done; assert.notEqual(r1.status, 0); assert.match(r1.update?.reasons?.[0] || "", /countersign/);
  L.manifests.set("u2", signedManifest(K, v(1), bytes, { releaseKey: K.other }));
  const r2 = await update(d, "u2").done; assert.notEqual(r2.status, 0); assert.match(r2.update?.reasons?.[0] || "", /release key this client's anchor does not name/);
  L.manifests.set("u2", signedManifest(K, V, fakeArtifact(V))); L.artifacts.set("u2", { bytes: fakeArtifact(V) });
  const r3 = await update(d, "u2").done; assert.notEqual(r3.status, 0); assert.match(r3.update?.reasons?.[0] || "", new RegExp(`not newer than the installed ${esc(V)}`));
  assert.equal(staged(d), null); assert.deepEqual(fs.readdirSync(d.install), []);
});
test("two stagers, both completion orders: the older version can never replace the newer, the newer replaces the older", { skip }, async () => {
  const d = dirFor("u3"); install(CLI, tmp, d.state, K);
  put("u3-old", v(1), { hold: true }); const newBytes = put("u3-new", v(2));
  const older = update(d, "u3-old"); await L.artifactRequested("u3-old");             // the older download is held
  const r = await update(d, "u3-new").done; assert.equal(r.status, 0, r.out);          // the newer completes first
  L.release("artifact:u3-old"); const ro = await older.done;
  assert.notEqual(ro.status, 0); assert.match(ro.update?.reasons?.[0] || "", new RegExp(`update ${esc(v(2))} is already staged: ${esc(v(1))} cannot replace it`));
  assert.equal(staged(d)?.version, v(2)); assert.equal(staged(d)?.bytesMatch, true);
  // F1 (since 0.2.1): a stager refused on the newest state before publishing leaves nothing; only the staged file is there
  assert.deepEqual(fs.readdirSync(d.install), [`pvm-client-${v(2)}-${sha256(newBytes)}.mjs`], "the refused sequential stager published nothing");
  const d2 = dirFor("u3b"); install(CLI, tmp, d2.state, K); put("u3b-old", v(1)); put("u3b-new", v(2), { hold: true });
  const newer = update(d2, "u3b-new"); await L.artifactRequested("u3b-new");
  assert.equal((await update(d2, "u3b-old").done).status, 0); assert.equal(staged(d2)?.version, v(1));
  L.release("artifact:u3b-new"); assert.equal((await newer.done).status, 0); assert.equal(staged(d2)?.version, v(2));
});
test("policy-key rotation: only a signed nextPolicyKey moves the anchor; afterwards the retired key's policies and a rollback under it are refused", { skip }, async () => {
  const d = dirFor("u4"); install(CLI, tmp, d.state, K);
  L.policies.set("rot3", signedPolicy(K, 3, { nextPolicyKey: rawPub(K.policy2).toString("hex") }));
  L.policies.set("k2-1", signedPolicy(K, 1, { key: K.policy2 })); L.policies.set("k2-4", signedPolicy(K, 4, { key: K.policy2 }));
  L.policies.set("k1-5", signedPolicy(K, 5)); L.policies.set("k1-2", signedPolicy(K, 2));
  const r0 = await run(d, "k2-1", "u4-0").done;                                           // before rotation key 2 is a stranger
  assert.equal(r0.result?.step, "policy"); assert.match(r0.result?.refused || "", /anchor does not name/); assert.equal(L.count("u4-0"), 0);
  await runToEvidence(d, "rot3", "u4-a");
  assert.equal(committedState(CLI, tmp, d.state)?.nextPolicyFp, fpOf(K.policy2), "the successor is recorded at commit");
  await runToEvidence(d, "k2-4", "u4-b");                                                  // the successor signs: accepted
  const st = committedState(CLI, tmp, d.state); assert.equal(st?.serial, 4); assert.equal(st?.policyFp, fpOf(K.policy2), "the anchor moved"); assert.equal(st?.nextPolicyFp, null);
  const c = await run(d, "k1-5", "u4-c").done; assert.equal(c.result?.step, "policy", `the retired key is refused (${JSON.stringify(c.result)})`); assert.equal(L.count("u4-c"), 0);
  const e = await run(d, "k1-2", "u4-e").done; assert.equal(e.result?.step, "policy"); assert.equal(L.count("u4-e"), 0);
  assert.equal(committedState(CLI, tmp, d.state)?.serial, 4);
});
test("release-key rotation and a policy commit, both orders: neither commit loses the other's fields; the successor release key then signs, a stranger does not", { skip }, async () => {
  const d = dirFor("u5"); install(CLI, tmp, d.state, K);
  put("u5", v(1), { hold: true, nextReleaseKey: rawPub(K.release2).toString("hex") }); L.policies.set("p7", signedPolicy(K, 7)); L.policies.set("p8", signedPolicy(K, 8));
  const upd = update(d, "u5"); await L.artifactRequested("u5");                             // the update's download is held
  await runToEvidence(d, "p7", "u5-p"); assert.equal(committedState(CLI, tmp, d.state)?.serial, 7);
  L.release("artifact:u5"); const ru = await upd.done; assert.equal(ru.status, 0, ru.out);  // the update commits after the policy did
  let st = committedState(CLI, tmp, d.state);
  assert.equal(st?.serial, 7, "the policy's serial survived the update's commit"); assert.equal(st?.staged?.version, v(1)); assert.equal(st?.nextReleaseFp, fpOf(K.release2), "the release-key successor is recorded");
  await runToEvidence(d, "p8", "u5-q");                                                     // and a policy commit after the update
  st = committedState(CLI, tmp, d.state); assert.equal(st?.serial, 8); assert.equal(st?.staged?.version, v(1), "the staging survived the policy's commit"); assert.equal(st?.nextReleaseFp, fpOf(K.release2));
  put("u5b", v(2), { releaseKey: K.release2 }); const r2 = await update(d, "u5b").done; assert.equal(r2.status, 0, r2.out); assert.equal(staged(d)?.version, v(2));
  st = committedState(CLI, tmp, d.state); assert.equal(st?.releaseFp, fpOf(K.release2), "the release anchor moved"); assert.equal(st?.nextReleaseFp, null);
  put("u5c", v(3), { releaseKey: K.release }); const r3 = await update(d, "u5c").done; assert.notEqual(r3.status, 0, "the retired release key no longer signs");
  put("u5d", v(3), { releaseKey: K.other }); const r4 = await update(d, "u5d").done; assert.notEqual(r4.status, 0);
  assert.equal(staged(d)?.version, v(2));
});
test("a storm of concurrent updates and policy commits: whatever the interleaving, the final state is the highest version and serial, every loser was refused by the monotonic rule, and the generation count equals the commits", { skip }, async () => {
  const d = dirFor("u6"); install(CLI, tmp, d.state, K);
  const versions = [0, 1, 2, 3, 4, 5].map((i) => v(1, i)), serials = [10, 11, 12, 13, 14, 15];
  for (const v of versions) put(`u6-${v}`, v); for (const s of serials) L.policies.set(`u6-s${s}`, signedPolicy(K, s));
  const ups = versions.map((v) => update(d, `u6-${v}`)), runs = serials.map((s) => run(d, `u6-s${s}`, `u6-r${s}`));
  for (const s of serials) { await L.evidenceRequested(`u6-r${s}`).catch(() => {}); }   // each run either reached evidence or was refused
  for (const s of serials) if (L.count(`u6-r${s}`)) L.release(`u6-r${s}`);
  const ur = await Promise.all(ups.map((u) => u.done)), rr = await Promise.all(runs.map((r) => r.done));
  const st = committedState(CLI, tmp, d.state);
  assert.equal(st?.serial, 15); assert.equal(staged(d)?.version, v(1, 5)); assert.equal(staged(d)?.bytesMatch, true);
  let commits = 0;
  for (const [i, u] of ur.entries()) { if (u.status === 0) commits++; else assert.match(u.update?.reasons?.[0] || "", /is already staged: \d+\.\d+\.\d+ cannot replace it/, `update ${versions[i]}: ${u.out}`); }
  for (const [i, r] of rr.entries()) { if (r.committed) { commits++; assert.equal(r.committed.serial, serials[i]); } else assert.match(r.result?.refused || "", /a rollback, refused/, `run ${serials[i]}: ${r.out}`); }
  assert.equal(st.gen, 1 + commits, "one generation per successful commit, none lost, none duplicated");
});
// FINDING F2 (verifier/integration/findings.json; raised with the pVM owner 2026-09-24): stageUpdate writes the verified
// bytes to pvm-client-<version>.mjs BEFORE the commit decides, so a second manifest for the SAME version with other bytes
// (both signatures present: a re-signed build) is refused by the monotonic rule yet has already replaced the staged file,
// and `staged` then reports bytesMatch false. The three cases below assert the REQUIRED behaviour (the state's digest and
// the file on disk never disagree; a refused stager leaves the staged bytes untouched) and carry NO exemption: on the
// revision the finding was found on they fail and the strict command reports NOT ACCEPTED (exit 3), never a pass; on a
// revision that fixes it they must pass. The last case is the regression fixture: against the pinned pre-fix build (pin
// pvm-client-dist-f2) the defect must still reproduce, so the finding stays replayable after the main pin moves.
const F2 = process.env.ENCLAVE_PVM_CLIENT_F2_CLI || "";
if (STRICT && !(F2 && fs.existsSync(F2))) throw new Error("strict integration: ENCLAVE_PVM_CLIENT_F2_CLI (the pre-fix build finding F2 reproduces on, pin pvm-client-dist-f2) is missing");
const skipF2 = !(F2 && fs.existsSync(F2)) && !STRICT && "pre-fix build absent (pin pvm-client-dist-f2)";
const otherBytes = (v, tag) => Buffer.from(`/*! enclave-pvm-client ${v} (LAB, ${tag}) */\nexport const CLIENT_VERSION = ${JSON.stringify(v)};\n`);
const putBytes = (name, version, bytes, hold = false) => { L.artifacts.set(name, { bytes, hold }); L.manifests.set(name, signedManifest(K, version, bytes)); return bytes; };
const updateWith = (cli, d, name) => cliRun(cli, tmp, ["update", "--manifest", `${L.base}/manifest/${name}`, "--artifact", `${L.base}/artifact/${name}`, "--state", d.state, "--install-dir", d.install]);
const stagedWith = (cli, d) => cliSync(cli, tmp, ["staged", "--state", d.state, "--install-dir", d.install]).lines.find((l) => "staged" in l)?.staged ?? null;

test("a refused same-version re-stage must leave the staged bytes untouched", { skip }, async () => {   // sequential
  const d = dirFor("u7"); install(CLI, tmp, d.state, K);
  const a = put("u7-a", v(1)); const r1 = await update(d, "u7-a").done; assert.equal(r1.status, 0); assert.equal(staged(d)?.bytesMatch, true);
  putBytes("u7-b", v(1), otherBytes(v(1), "other bytes"));
  const r2 = await update(d, "u7-b").done; assert.notEqual(r2.status, 0); assert.match(r2.update?.reasons?.[0] || "", /already staged: \d+\.\d+\.\d+ cannot replace it/);
  assert.equal(staged(d)?.bytesMatch, true, "the refused stager must not replace the staged file's bytes");
  assert.equal(staged(d)?.sha256, sha256(a));
});
test("concurrent same-version stagers with other bytes: the state's digest and the file on disk never disagree, whichever completes last", { skip }, async () => {
  const d = dirFor("u8"); install(CLI, tmp, d.state, K);
  putBytes("u8-a", v(1), otherBytes(v(1), "a"), true); const b = putBytes("u8-b", v(1), otherBytes(v(1), "b"));
  const A = update(d, "u8-a"); await L.artifactRequested("u8-a");                       // A's download is held
  assert.equal((await update(d, "u8-b").done).status, 0); assert.equal(staged(d)?.sha256, sha256(b));
  L.release("artifact:u8-a"); const ra = await A.done; assert.notEqual(ra.status, 0);   // A loses the commit
  let s = staged(d); assert.equal(s?.sha256, sha256(b)); assert.equal(s?.bytesMatch, true, "the loser's bytes must not replace the winner's file");
  // a burst: six same-version stagers with different bytes at once, no holds: exactly one wins and the file holds its bytes
  const d2 = dirFor("u8b"); install(CLI, tmp, d2.state, K);
  const names = [0, 1, 2, 3, 4, 5].map((i) => { putBytes(`u8b-${i}`, v(1), otherBytes(v(1), `burst ${i}`)); return `u8b-${i}`; });
  const rs = await Promise.all(names.map((n) => update(d2, n).done));
  assert.equal(rs.filter((r) => r.status === 0).length, 1, "exactly one same-version stager wins");
  for (const r of rs) if (r.status !== 0) assert.match(r.update?.reasons?.[0] || "", /already staged: \d+\.\d+\.\d+ cannot replace it/);
  s = stagedWith(CLI, d2); assert.equal(s?.bytesMatch, true, "the file on disk must be the winner's bytes, whatever the completion order");
});
test("the same artifact again (same version, bytes and source commit) is idempotent: success, no new generation, the staged file untouched; the same bytes under another source commit are refused", { skip }, async () => {
  const d = dirFor("u9"); install(CLI, tmp, d.state, K);
  const a = put("u9-a", v(1)); assert.equal((await update(d, "u9-a").done).status, 0);
  const before = committedState(CLI, tmp, d.state), st0 = fs.statSync(staged(d).path);
  putBytes("u9-b", v(1), a); const r = await update(d, "u9-b").done;
  assert.equal(r.status, 0, r.out); assert.equal(r.update?.ok, true); assert.equal(r.update?.already, true, "the same artifact again is reported as already staged");
  const after = committedState(CLI, tmp, d.state), st1 = fs.statSync(staged(d).path);
  assert.equal(after.gen, before.gen, "no new generation"); assert.deepEqual([st1.ino, st1.mtimeMs, st1.size], [st0.ino, st0.mtimeMs, st0.size], "the staged file is untouched");
  assert.equal(staged(d)?.bytesMatch, true); assert.equal(staged(d)?.sha256, sha256(a));
  L.artifacts.set("u9-c", { bytes: a }); L.manifests.set("u9-c", signedManifest(K, v(1), a, { sourceCommit: "1".repeat(40) }));
  const rc = await update(d, "u9-c").done; assert.notEqual(rc.status, 0); assert.match(rc.update?.reasons?.[0] || "", /already staged: \d+\.\d+\.\d+ cannot replace it/);
  assert.equal(committedState(CLI, tmp, d.state).gen, before.gen); assert.equal(staged(d)?.bytesMatch, true);
});
test("regression fixture: on the pre-fix build (pin pvm-client-dist-f2) the refused same-version stager DOES replace the staged bytes", { skip: skipF2 }, async () => {
  const d = dirFor("f2"); install(F2, tmp, d.state, K);
  const f2v = (() => { const [a, b] = String(VF2).split(".").map(Number); return `${a}.${b + 1}.0`; })(); put("f2-a", f2v); assert.equal((await updateWith(F2, d, "f2-a").done).status, 0); assert.equal(stagedWith(F2, d)?.bytesMatch, true);
  putBytes("f2-b", f2v, otherBytes(f2v, "other bytes"));
  const r = await updateWith(F2, d, "f2-b").done; assert.notEqual(r.status, 0); assert.match(r.update?.reasons?.[0] || "", /already staged/);
  assert.equal(stagedWith(F2, d)?.bytesMatch, false, "finding F2 no longer reproduces on the recorded revision: close it in verifier/integration/findings.json");
});
