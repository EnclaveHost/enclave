// The installed client's rollback memory under crashes, stalls, concurrency and failed writes (client/DESIGN.md "State").
// Every interleaving is forced by a deterministic barrier -- a carrier that holds a request until the test releases it, or
// a driver process that pauses between reading the state and committing (test/fixtures/pvm-client-store-driver.mjs) --
// never by timing. The first test reproduces the audit finding on the shipped 0.1.0 artifact (4e55879b) with the same
// barriers the fixed 0.2.0 client then survives.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { FileStore, StoreError } from "../shielded/anchor/avf/client/src/store-file.js";
import { ExtStore } from "../shielded/anchor/avf/client/src/store-ext.js";
import { acceptPolicy } from "../shielded/anchor/avf/client/src/client.js";
import { stageUpdate } from "../shielded/anchor/avf/client/src/update.js";
import { initialState, VERSION_MARKER } from "../shielded/anchor/avf/client/src/trust.js";
import { heldCarrier } from "./fixtures/held-carrier.mjs";

const CLI = new URL("../shielded/anchor/avf/client/dist/pvm-client.mjs", import.meta.url).pathname;
const DRIVER = new URL("./fixtures/pvm-client-store-driver.mjs", import.meta.url).pathname;
const sha = (b) => createHash("sha256").update(b).digest("hex");
const key = () => { const k = generateKeyPairSync("ed25519"); const pub = k.publicKey.export({ type: "spki", format: "der" }).subarray(12).toString("hex"); return { k, pub, fp: sha(Buffer.from(pub, "hex")) }; };
const esig = (t, domain, K) => edSign(null, Buffer.concat([Buffer.from(domain), Buffer.from(t)]), K.k.privateKey).toString("hex");
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const APP = "ab".repeat(32);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
function policyFile(dir, K, serial, over = {}) {
  const t = JSON.stringify({ type: "enclave-pvm-client-policy", key: K.pub, serial, notBefore: iso(Date.now() - 3600e3), notAfter: iso(Date.now() + 3600e3),
    codeHashes: ["cc".repeat(32)], authorityHashes: ["dd".repeat(64)], runtimeIds: ["ee".repeat(32)], appIds: [APP],
    googleRootPins: ["6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0"], formats: ["enclave-pvm-app-evidence/v2"], sealedModes: ["chunked", "whole"],
    sealedWindow: { seconds: 600, maxRequests: 256 }, minClientVersion: "0.1.0", nextPolicyKey: null, ...over });
  const f = path.join(dir, `policy-${serial}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ policy: Buffer.from(t).toString("base64"), sig: esig(t, "enclave-pvm-client-policy-v1\n", K) }));
  return f;
}
function run(bin, args) {
  const c = spawn(process.execPath, [bin, ...args]); let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.done = new Promise((r) => c.on("close", (code) => r({ code, out, lines: out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } }) })));
  return c;
}
const result = (o) => (o.lines.find((l) => l.result) || {}).result || {};
const readSerial = (st) => { if (fs.statSync(st).isFile()) return JSON.parse(fs.readFileSync(st, "utf8")).serial; return new FileStore(st).latest().state.serial; };
async function barrierRun(bin, label) {   // the crash/stall and the overlap, with the carrier as the barrier
  const dir = tmp(`pvm-dur-${label}-`), st = path.join(dir, "state"), P = key(), R = key(), carrier = heldCarrier();
  await new Promise((r) => carrier.srv.on("listening", r));
  const args = (f) => ["run", "--state", st, "--policy", f, "--relay", carrier.url(), "--app", APP];
  await run(bin, ["install", "--state", st, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp]).done;
  const out = {};
  // (a) policy 2 accepted, the carrier stalls its evidence request, the process is killed there
  const a = run(bin, args(policyFile(dir, P, 2)));
  await carrier.until(1);
  out.serialAtBarrier = readSerial(st);
  a.kill("SIGKILL"); await a.done;
  out.serialAfterKill = readSerial(st);
  const rb = run(bin, args(policyFile(dir, P, 1)));
  const rbDone = rb.done.then((o) => ({ exited: o })), rbHeld = carrier.until(2).then(() => ({ held: true }));
  const first = await Promise.race([rbDone, rbHeld]);
  if (first.held) { carrier.answer(1); out.rollback = "reached the carrier"; await rb.done; } else out.rollback = result(first.exited).refused || "exited";
  // (b) an older and a newer policy in two processes: the newer's evidence is held while the older runs
  const n0 = carrier.held.length;
  const A = run(bin, args(policyFile(dir, P, 4)));
  await carrier.until(n0 + 1);
  const B = run(bin, args(policyFile(dir, P, 3)));
  const bFirst = await Promise.race([B.done.then((o) => ({ exited: o })), carrier.until(n0 + 2).then(() => ({ held: true }))]);
  // deterministic write order: the newer run is answered and finishes FIRST, then the older one -- so an older run that
  // was accepted writes last (never left to which process happens to finish writing first)
  out.older = bFirst.held ? "reached the carrier" : result(bFirst.exited).refused;
  carrier.answer(n0); await A.done;
  if (bFirst.held) carrier.answer(n0 + 1);
  await B.done;
  out.finalSerial = readSerial(st);
  carrier.srv.close();
  return out;
}

test("the finding, reproduced on the shipped 0.1.0 artifact: a kill at a stalled carrier and an overlapping older run bring the floor back", async (t) => {
  const old = path.join(tmp("pvm-010-"), "pvm-client-0.1.0.mjs");
  try { fs.writeFileSync(old, execFileSync("git", ["show", "4e55879b:shielded/anchor/avf/client/dist/pvm-client.mjs"], { cwd: new URL("..", import.meta.url).pathname })); }
  catch { t.skip("4e55879b not in this checkout"); return; }
  assert.equal(sha(fs.readFileSync(old)), "52d4483245eeb4fa37f4f57eb2c7e416a9c5c57c54d1436dabffdae6f230897c");
  const o = await barrierRun(old, "010");
  assert.equal(o.serialAtBarrier, 1, "0.1.0: the accepted policy is not recorded when its evidence request is already out");
  assert.equal(o.serialAfterKill, 1, "0.1.0: killed there, the old floor remains");
  assert.equal(o.rollback, "reached the carrier", "0.1.0: the rollback to policy 1 is accepted and goes on to the carrier");
  assert.equal(o.older, "reached the carrier", "0.1.0: an older policy overlapping a newer one is accepted too");
  assert.equal(o.finalSerial, 3, "0.1.0: the older run wrote last and the floor went back from 4 to 3");
});

test("since 0.2.0: the policy is committed before the evidence request; a kill at a stalled carrier keeps the new floor; the rollback and the overlapping older run are refused", async () => {
  const o = await barrierRun(CLI, "020");
  assert.equal(o.serialAtBarrier, 2, "committed before the evidence request left");
  assert.equal(o.serialAfterKill, 2);
  assert.match(o.rollback, /rollback/);
  assert.match(o.older, /rollback/);
  assert.equal(o.finalSerial, 4);
});

// ---- two processes, each paused between reading the state and committing ----
function driver(args) { return run(DRIVER, args); }
async function reached(barrier, name) { for (let i = 0; i < 2000; i++) { if (fs.existsSync(path.join(barrier, `${name}.reached`))) return JSON.parse(fs.readFileSync(path.join(barrier, `${name}.reached`), "utf8")); await wait(10); } throw new Error(`${name} never reached its barrier`); }
const go = (barrier, name) => fs.writeFileSync(path.join(barrier, `${name}.go`), "");
async function pair(store, first, second, between = () => {}) {   // both read the same generation, then commit in the order given
  const barrier = tmp("pvm-bar-");
  const kids = Object.fromEntries([first, second].map((d) => [d.name, driver([...d.args(barrier)])]));
  const r1 = await reached(barrier, first.name), r2 = await reached(barrier, second.name);
  assert.equal(r1.serial, r2.serial, "both read the same state before either committed");
  go(barrier, first.name); const o1 = (await kids[first.name].done).lines[0];
  await between();
  go(barrier, second.name); const o2 = (await kids[second.name].done).lines[0];
  return { [first.name]: o1, [second.name]: o2, state: store.latest().state, gen: store.latest().gen };
}
function installed(serial = 1, P = key(), R = key()) {
  const dir = tmp("pvm-store-"), store = new FileStore(path.join(dir, "state.d"));
  assert.equal(store.init({ ...initialState({ policyKeyFp: P.fp, serialFloor: serial, releaseKeyFp: R.fp }), staged: null }).ok, true);
  return { dir, store, P, R };
}
const pdrv = (name, st, pf) => ({ name, args: (b) => ["policy", st.store.dir, pf, b, name] });

test("processes: an older and a newer policy that read the same state -- in either commit order the floor ends at the newer, the older refused or superseded", async () => {
  for (const order of ["newer-first", "older-first"]) {
    const st = installed(2);
    const newer = pdrv("newer", st, policyFile(st.dir, st.P, 4)), older = pdrv("older", st, policyFile(st.dir, st.P, 3));
    const r = await pair(st.store, ...(order === "newer-first" ? [newer, older] : [older, newer]));
    assert.equal(r.state.serial, 4, `${order}: the floor ends at the newer policy`);
    if (order === "newer-first") { assert.equal(r.newer.ok, true); assert.equal(r.older.ok, false); assert.match(r.older.reason, /rollback/, "re-decided on the newest state: a rollback"); }
    else { assert.equal(r.older.ok, true); assert.equal(r.newer.ok, true); assert.equal(r.gen, 3, "two commits, in order"); }
  }
});

test("processes: two different policies with the same serial -- one commits, the other is refused as equivocation", async () => {
  const st = installed(2);
  const r = await pair(st.store, pdrv("x", st, policyFile(st.dir, st.P, 5)), pdrv("y", st, policyFile(st.dir, st.P, 5, { appIds: ["cd".repeat(32)] })));
  assert.equal(r.x.ok, true); assert.equal(r.y.ok, false); assert.match(r.y.reason, /equivocation/); assert.equal(r.state.serial, 5);
});

test("processes: key rotation racing its own successor and a rollback under the retired key", async () => {
  const K2 = key();
  // the rotating policy (serial 6, K1 names K2) and K2's first policy (serial 7) read the same state; K2's first
  for (const order of ["successor-first", "rotation-first"]) {
    const st = installed(5);
    const rot = pdrv("rot", st, policyFile(st.dir, st.P, 6, { nextPolicyKey: K2.pub })), succ = pdrv("succ", st, policyFile(st.dir, K2, 7));
    const r = await pair(st.store, ...(order === "successor-first" ? [succ, rot] : [rot, succ]));
    if (order === "successor-first") {
      assert.equal(r.succ.ok, false, "K2 before K1 named it: refused on the newest state"); assert.match(r.succ.reason, /anchor does not name/);
      assert.equal(r.rot.ok, true); assert.equal(r.state.serial, 6); assert.equal(r.state.nextPolicyFp, K2.fp);
    } else {
      assert.equal(r.rot.ok, true); assert.equal(r.succ.ok, true, "re-decided after the rotation committed: accepted");
      assert.equal(r.state.serial, 7); assert.equal(r.state.policyFp, K2.fp);
      const late = await acceptPolicy(st.store, JSON.parse(fs.readFileSync(policyFile(st.dir, st.P, 8), "utf8")));
      assert.equal(late.ok, false); assert.match(late.reason, /anchor does not name/, "K1 is retired");
    }
  }
});

// updates: artifacts carrying their own version line, manifests release-signed and policy-countersigned
function updateFiles(dir, P, R, version, over = {}, variant = "") {   // variant: other bytes under the same version (a re-signed build)
  const bytes = Buffer.from(`${VERSION_MARKER}${version} (LAB) */\nexport const v = ${JSON.stringify(version)};${variant ? ` // ${variant}` : ""}\n`);
  const af = path.join(dir, `a-${version}-${Math.random().toString(16).slice(2)}.mjs`); fs.writeFileSync(af, bytes);
  const t = JSON.stringify({ type: "enclave-pvm-client-update", artifact: "pvm-client.mjs", version, artifactSha256: sha(bytes), size: bytes.length, sourceCommit: "ab".repeat(20),
    notAfter: iso(Date.now() + 3600e3), releaseKey: R.pub, policyKey: P.pub, nextReleaseKey: null, ...over });
  const mf = path.join(dir, `m-${version}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(mf, JSON.stringify({ manifest: Buffer.from(t).toString("base64"), releaseSig: esig(t, "enclave-pvm-client-update-v1\n", R), policySig: esig(t, "enclave-pvm-client-update-countersign-v1\n", P) }));
  return { mf, af, bytes, sha: sha(bytes), name: `pvm-client-${version}-${sha(bytes)}.mjs`, env: JSON.parse(fs.readFileSync(mf, "utf8")) };
}
// what an install directory holds (published artifacts and any temp file), and one file's identity: its bytes AND the file itself
const published = (d) => fs.readdirSync(d).filter((n) => /^\.?pvm-client-/.test(n)).sort();
const fileId = (f) => { const st = fs.statSync(f); return { sha: sha(fs.readFileSync(f)), ino: st.ino, mtimeMs: st.mtimeMs, mode: st.mode & 0o777 }; };
const udrv = (name, st, u, installDir) => ({ name, args: (b) => ["update", st.store.dir, u.mf, u.af, b, name, installDir, "0.2.0"] });

test("processes: two updates staged concurrently -- the newer stays staged, the older cannot replace it, whatever the order", async () => {
  for (const order of ["newer-first", "older-first"]) {
    const st = installed(1); const inst = tmp("pvm-inst-");
    const f3 = updateFiles(st.dir, st.P, st.R, "0.3.0"), f4 = updateFiles(st.dir, st.P, st.R, "0.4.0");
    const u3 = udrv("u3", st, f3, inst), u4 = udrv("u4", st, f4, inst);
    let firstId;
    const r = await pair(st.store, ...(order === "newer-first" ? [u4, u3] : [u3, u4]), () => { firstId = fileId(path.join(inst, order === "newer-first" ? f4.name : f3.name)); });
    assert.equal(r.state.staged.version, "0.4.0", `${order}: the newer is staged`);
    assert.equal(r.state.staged.file, f4.name);
    assert.equal(sha(fs.readFileSync(path.join(inst, r.state.staged.file))), r.state.staged.sha256, "the staged file's bytes are the recorded ones");
    assert.deepEqual(fileId(path.join(inst, order === "newer-first" ? f4.name : f3.name)), firstId, "the first commit's file is untouched by the second stager");
    assert.deepEqual(published(inst), [f3.name, f4.name].sort(), "each published under its own name; no temp file left");
    if (order === "newer-first") { assert.equal(r.u3.ok, false); assert.match(r.u3.reason, /already staged/); } else assert.equal(r.u3.ok, true);
  }
});

test("processes: the same version with OTHER bytes (a re-signed build), concurrently, both orders -- the first commit stands, the other is refused and cannot touch the staged file", async () => {
  for (const order of ["a-first", "b-first"]) {
    const st = installed(1); const inst = tmp("pvm-inst-");
    const fa = updateFiles(st.dir, st.P, st.R, "0.3.0", {}, "build a"), fb = updateFiles(st.dir, st.P, st.R, "0.3.0", {}, "build b");
    assert.notEqual(fa.sha, fb.sha);
    const [win, lose] = order === "a-first" ? [fa, fb] : [fb, fa];
    let winId;
    const r = await pair(st.store, ...(order === "a-first" ? [udrv("a", st, fa, inst), udrv("b", st, fb, inst)] : [udrv("b", st, fb, inst), udrv("a", st, fa, inst)]),
                         () => { winId = fileId(path.join(inst, win.name)); });
    const [ow, ol] = order === "a-first" ? [r.a, r.b] : [r.b, r.a];
    assert.equal(ow.ok, true); assert.equal(ol.ok, false);
    assert.match(ol.reason, /already staged: 0\.3\.0 cannot replace it/); assert.match(ol.reason, /second signed artifact under the same version/);
    assert.equal(r.gen, 2, "one commit"); assert.equal(r.state.staged.sha256, win.sha); assert.equal(r.state.staged.file, win.name);
    assert.deepEqual(fileId(path.join(inst, win.name)), winId, `${order}: the staged file -- bytes, inode, mtime, mode -- is exactly what the winner committed`);
    assert.equal(winId.sha, win.sha); assert.equal(winId.mode, 0o444, "published read-only");
    assert.deepEqual(published(inst), [fa.name, fb.name].sort(), "the loser's bytes sit under their own name, named by no state; no temp file");
  }
});

test("processes: the SAME artifact staged twice, concurrently -- both succeed, one commit, the file is published once and never rewritten", async () => {
  const st = installed(1); const inst = tmp("pvm-inst-"); const f = updateFiles(st.dir, st.P, st.R, "0.3.0");
  let id;
  const r = await pair(st.store, udrv("x", st, f, inst), udrv("y", st, f, inst), () => { id = fileId(path.join(inst, f.name)); });
  assert.equal(r.x.ok, true); assert.equal(r.y.ok, true, JSON.stringify(r.y)); assert.equal(r.y.already, true, "the second is idempotent");
  assert.equal(r.gen, 2, "one commit"); assert.deepEqual(fileId(path.join(inst, f.name)), id); assert.deepEqual(published(inst), [f.name]);
});

// the update finding (the verifier session's review of 0.2.0), black-box on the shipped bytes and on the current build
async function sameVersionRestage(bin) {
  const dir = tmp("pvm-restage-"), st = path.join(dir, "state"), inst = path.join(dir, "inst"), P = key(), R = key(); fs.mkdirSync(inst);
  await run(bin, ["install", "--state", st, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp]).done;
  const upd = async (f) => (await run(bin, ["update", "--state", st, "--manifest", f.mf, "--artifact", f.af, "--install-dir", inst]).done);
  const fa = updateFiles(dir, P, R, "9.3.0", {}, "build a"), fb = updateFiles(dir, P, R, "9.3.0", {}, "build b");   // newer than any client under test
  const a = await upd(fa), b = await upd(fb), staged = (await run(bin, ["staged", "--state", st, "--install-dir", inst]).done);
  return { a: a.lines.at(-1).update, b: b.lines.at(-1).update, bCode: b.code, staged: staged.lines[0].staged, files: published(inst) };
}
test("the update finding, reproduced on the shipped 0.2.0 artifact and refused by the current one: a refused same-version re-stage must leave the staged bytes untouched", async (t) => {
  const old = path.join(tmp("pvm-020-"), "pvm-client-0.2.0.mjs");
  try { fs.writeFileSync(old, execFileSync("git", ["show", "6784f671:shielded/anchor/avf/client/dist/pvm-client.mjs"], { cwd: new URL("..", import.meta.url).pathname })); }
  catch { t.skip("6784f671 not in this checkout"); return; }
  assert.equal(sha(fs.readFileSync(old)), "3782de92df2ecc0d13262fc94470b90e694654f35452211b68073468b3f1ded6");
  const o = await sameVersionRestage(old);
  assert.equal(o.a.ok, true); assert.equal(o.b.ok, false); assert.notEqual(o.bCode, 0); assert.match(o.b.reasons[0], /already staged: 9\.3\.0 cannot replace it/);
  assert.equal(o.staged.bytesMatch, false, "0.2.0: refused, yet its bytes replaced the staged file");
  const n = await sameVersionRestage(CLI);
  assert.equal(n.a.ok, true, JSON.stringify(n.a)); assert.equal(n.b.ok, false); assert.notEqual(n.bCode, 0); assert.match(n.b.reasons[0], /already staged: 9\.3\.0 cannot replace it/);
  assert.equal(n.staged.bytesMatch, true, "the staged bytes are the committed ones"); assert.equal(n.files.length, 1, "the refused stager published nothing");
});

test("updates in sequence: an identical re-stage changes nothing (and repairs a missing file), other bytes under the staged version are refused, a planted file is left alone", async () => {
  const st = installed(1); const inst = tmp("pvm-inst-");
  const fa = updateFiles(st.dir, st.P, st.R, "0.3.0", {}, "build a"), fb = updateFiles(st.dir, st.P, st.R, "0.3.0", {}, "build b");
  const stage = (f) => stageUpdate(st.store, f.env, f.bytes, { dir: inst, currentVersion: "0.2.0" });
  const a = await stage(fa); assert.equal(a.ok, true); assert.equal(a.gen, 2);
  const id = fileId(path.join(inst, fa.name));
  const again = await stage(fa);
  assert.equal(again.ok, true); assert.equal(again.already, true); assert.equal(again.gen, 2, "nothing recorded"); assert.deepEqual(fileId(path.join(inst, fa.name)), id, "nothing rewritten");
  const b = await stage(fb);
  assert.equal(b.ok, false); assert.match(b.reason, /already staged: 0\.3\.0 cannot replace it/);
  assert.deepEqual(fileId(path.join(inst, fa.name)), id, "the staged file is untouched"); assert.deepEqual(published(inst), [fa.name], "refused before publishing: no leftover");
  assert.equal(st.store.latest().gen, 2);
  // an older version after a newer one is staged: refused, nothing published
  const f2 = updateFiles(st.dir, st.P, st.R, "0.2.5"); const old = await stage(f2);
  assert.equal(old.ok, false); assert.match(old.reason, /0\.3\.0 is already staged: 0\.2\.5 cannot replace it/); assert.deepEqual(published(inst), [fa.name]);
  // the staged file removed behind the client's back: the same artifact again puts it back, still one generation
  fs.rmSync(path.join(inst, fa.name));
  const heal = await stage(fa); assert.equal(heal.ok, true); assert.equal(heal.already, true); assert.equal(heal.gen, 2);
  assert.equal(sha(fs.readFileSync(path.join(inst, fa.name))), fa.sha);
  // a file planted under the name the next version's bytes would take: refused, left as it was, nothing staged
  const f4 = updateFiles(st.dir, st.P, st.R, "0.4.0"); fs.writeFileSync(path.join(inst, f4.name), "planted");
  const p = await stage(f4); assert.equal(p.ok, false); assert.match(p.reason, /already exists with bytes other than its name says/);
  assert.equal(fs.readFileSync(path.join(inst, f4.name), "utf8"), "planted"); assert.equal(st.store.latest().state.staged.version, "0.3.0");
});

test("update write and commit failures: nothing staged changes; a failed commit leaves at most an unreferenced file, which a retry reuses; a crash between publish and commit likewise", async () => {
  const st = installed(1); const inst = tmp("pvm-inst-");
  const f3 = updateFiles(st.dir, st.P, st.R, "0.3.0"), f4 = updateFiles(st.dir, st.P, st.R, "0.4.0"), f5 = updateFiles(st.dir, st.P, st.R, "0.5.0");
  const stage = (f, store = st.store) => stageUpdate(store, f.env, f.bytes, { dir: inst, currentVersion: "0.2.0" });
  assert.equal((await stage(f3)).ok, true);
  const id3 = fileId(path.join(inst, f3.name));
  // the install directory cannot be written
  fs.chmodSync(inst, 0o500);
  try { const w = await stage(f4); assert.equal(w.ok, false); assert.match(w.reason, /could not write the verified artifact/); }
  finally { fs.chmodSync(inst, 0o700); }
  assert.equal(st.store.latest().state.staged.version, "0.3.0"); assert.equal(st.store.latest().gen, 2); assert.deepEqual(published(inst), [f3.name]);
  // the state cannot be committed: the new bytes are published under their own name, named by nothing; the staged one stands
  fs.chmodSync(st.store.dir, 0o500);
  try { const c = await stage(f4); assert.equal(c.ok, false); assert.match(c.reason, /could not record the staged update durably/); }
  finally { fs.chmodSync(st.store.dir, 0o700); }
  assert.equal(st.store.latest().state.staged.version, "0.3.0"); assert.deepEqual(fileId(path.join(inst, f3.name)), id3);
  assert.deepEqual(published(inst), [f3.name, f4.name].sort(), "no temp file left");
  const id4 = fileId(path.join(inst, f4.name));
  const retry = await stage(f4); assert.equal(retry.ok, true); assert.equal(retry.gen, 3);
  assert.deepEqual(fileId(path.join(inst, f4.name)), id4, "the retry reused the published file, not rewrote it");
  // a store that throws on commit
  const throwing = { latest: () => st.store.latest(), update: async () => { throw new StoreError("disk full"); } };
  const t = await stage(f5, throwing); assert.equal(t.ok, false); assert.match(t.reason, /could not record the staged update durably \(disk full\)/);
  assert.equal(st.store.latest().state.staged.version, "0.4.0"); assert.deepEqual(fileId(path.join(inst, f4.name)), id4);
  // a crash after publishing, before committing: the driver is killed at its barrier
  const barrier = tmp("pvm-bar-"), f6 = updateFiles(st.dir, st.P, st.R, "0.6.0");
  const kid = driver(["update", st.store.dir, f6.mf, f6.af, barrier, "crash", inst, "0.2.0"]);
  await reached(barrier, "crash"); kid.kill("SIGKILL"); await kid.done;
  assert.equal(st.store.latest().state.staged.version, "0.4.0", "nothing committed"); assert.equal(st.store.latest().gen, 3);
  assert.ok(published(inst).includes(f6.name), "published before the commit");
  assert.deepEqual(fileId(path.join(inst, f4.name)), id4, "the staged file is untouched");
  const after = await stage(f6); assert.equal(after.ok, true); assert.equal(after.gen, 4); assert.equal(sha(fs.readFileSync(path.join(inst, f6.name))), f6.sha);
});

test("processes: a policy commit and an update that rotates the release key, concurrently -- neither loses the other's change", async () => {
  for (const order of ["update-first", "policy-first"]) {
    const st = installed(1); const inst = tmp("pvm-inst-"); const R2 = key();
    const upd = udrv("upd", st, updateFiles(st.dir, st.P, st.R, "0.3.0", { nextReleaseKey: R2.pub }), inst);
    const pol = pdrv("pol", st, policyFile(st.dir, st.P, 3));
    const r = await pair(st.store, ...(order === "update-first" ? [upd, pol] : [pol, upd]));
    assert.equal(r.upd.ok, true, JSON.stringify(r.upd)); assert.equal(r.pol.ok, true, JSON.stringify(r.pol));
    assert.equal(r.state.serial, 3, `${order}: the policy's serial survived`);
    assert.equal(r.state.nextReleaseFp, R2.fp, `${order}: the release-key rotation survived`);
    assert.equal(r.state.staged.version, "0.3.0", `${order}: the staged update survived`);
  }
});

test("failed persistence: a read-only state, an unreadable newest generation, a store that throws -- nothing reaches the carrier", async () => {
  const P = key(), R = key(), dir = tmp("pvm-ro-"), st = path.join(dir, "state"), carrier = heldCarrier();
  await new Promise((r) => carrier.srv.on("listening", r));
  await run(CLI, ["install", "--state", st, "--policy-key-fp", P.fp, "--serial-floor", "1", "--release-key-fp", R.fp]).done;
  fs.chmodSync(st, 0o500);
  try {
    const o = await run(CLI, ["run", "--state", st, "--policy", policyFile(dir, P, 2), "--relay", carrier.url(), "--app", APP]).done;
    assert.equal(result(o).step, "commit"); assert.match(result(o).refused, /could not record the policy durably/); assert.equal(result(o).sent, false); assert.notEqual(o.code, 0);
  } finally { fs.chmodSync(st, 0o700); }
  assert.equal(readSerial(st), 1);
  fs.writeFileSync(path.join(st, "1.json"), "{ not json");
  const o2 = await run(CLI, ["run", "--state", st, "--policy", policyFile(dir, P, 2), "--relay", carrier.url(), "--app", APP]).done;
  assert.equal(o2.code, 2); assert.match(o2.lines.at(-1).error, /unreadable.*an older generation would itself be a rollback/);
  assert.equal(carrier.held.length, 0, "no request ever reached the carrier");
  carrier.srv.close();
  const broken = { latest: () => ({ gen: 1, state: {} }), update: async () => { throw new StoreError("disk full"); } };
  const r = await acceptPolicy(broken, JSON.parse(fs.readFileSync(policyFile(dir, P, 2), "utf8")));
  assert.equal(r.ok, false); assert.match(r.reason, /could not record the policy durably \(disk full\): nothing is sent/);
});

test("the CLI imports a 0.1.0 state file once into its generation log, keeping its floor", async () => {
  const P = key(), R = key(), dir = tmp("pvm-mig-"), file = path.join(dir, "state.json");
  fs.writeFileSync(file, JSON.stringify({ ...initialState({ policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: R.fp }), serial: 7, digest: "aa".repeat(32) }));
  const o = await run(CLI, ["run", "--state", file, "--policy", policyFile(dir, P, 6), "--relay", "http://127.0.0.1:9", "--app", APP]).done;
  assert.ok(o.lines.some((l) => l.imported === file)); assert.match(result(o).refused, /rollback/, "the imported floor holds");
  assert.equal(new FileStore(file + ".d").latest().state.serial, 7);
});

// ---- the extension's store: the same rules on chrome.storage under a lock (the browser's own lock is tested in Chrome) ----
const reorder = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reorder(v[k])])) : v);
function fakeExt({ failSet = false, dropSet = false } = {}) {
  let data = {}; let chain = Promise.resolve();
  return {
    // like Chrome's storage, give objects back with their keys reordered (the store must not depend on key order)
    storage: { get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in data).map((k) => [k, reorder(structuredClone(data[k]))])),
               set: async (o) => { if (failSet) throw new Error("QUOTA_BYTES quota exceeded"); if (!dropSet) data = { ...data, ...structuredClone(o) }; } },
    locks: { request: (name, opts, cb) => { const p = chain.then(() => cb()); chain = p.catch(() => {}); return p; } },   // a serialising stand-in for navigator.locks
    peek: () => data,
  };
}
test("the extension store: commits under its lock, refuses when storage throws or a write does not stick, imports a 0.1.0 state", async () => {
  const P = key(), R = key(), dir = tmp("pvm-ext-store-");
  const env = (s, o) => JSON.parse(fs.readFileSync(policyFile(dir, P, s, o), "utf8"));
  const f = fakeExt(); const store = new ExtStore(f.storage, f.locks);
  assert.equal((await store.init({ ...initialState({ policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: R.fp }), staged: null })).ok, true);
  const [a, b] = await Promise.all([acceptPolicy(store, env(4)), acceptPolicy(store, env(3))]);   // queued behind one lock
  assert.equal(a.ok, true); assert.equal(b.ok, false); assert.match(b.reason, /rollback/); assert.equal(f.peek().stateDoc.state.serial, 4);
  const failing = fakeExt({ failSet: true }), s2 = new ExtStore(failing.storage, failing.locks);
  failing.storage.set = (orig => async (o) => { if (o.stateDoc && o.stateDoc.gen > 1) throw new Error("QUOTA_BYTES quota exceeded"); return orig(o); })(fakeExt().storage.set);
  const d2 = { stateDoc: { gen: 1, state: { ...initialState({ policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: R.fp }), staged: null } } };
  failing.storage.get = async () => structuredClone(d2);
  const r2 = await acceptPolicy(s2, env(2));
  assert.equal(r2.ok, false); assert.match(r2.reason, /could not record the policy durably.*QUOTA/);
  const dropping = fakeExt({ dropSet: true }), s3 = new ExtStore(dropping.storage, dropping.locks);
  dropping.storage.get = async () => structuredClone(d2);
  const r3 = await acceptPolicy(s3, env(2));
  assert.equal(r3.ok, false); assert.match(r3.reason, /did not stick/);
  const legacy = fakeExt(), s4 = new ExtStore(legacy.storage, legacy.locks);
  await legacy.storage.set({ state: { ...initialState({ policyKeyFp: P.fp, serialFloor: 1, releaseKeyFp: R.fp }), serial: 9 } });
  assert.match((await acceptPolicy(s4, env(8))).reason, /rollback/, "a 0.1.0 extension's floor holds");
  assert.equal((await acceptPolicy(s4, env(10))).ok, true); assert.equal(legacy.peek().stateDoc.gen, 1, "imported as the first generation");
});
