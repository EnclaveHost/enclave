// Fenced, journalled rollouts on local release roots: generation compare-and-swap, root identity, durable cancellation
// (a late activation after resolve cannot commit), undo fenced to its own activation (A-B-A) with retryable attempts,
// atomic history publication, unconfirmed rollbacks kept pending, the OS lock under two real processes, interleaved
// rollouts, and resolve in a NEW process after the orchestrator was killed. Real files and child processes; the
// real-server and real-ssh cases (Caddy, OpenSSH) are test/site-delivery.test.mjs.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { prepareRelease } from "../scripts/site-release/release.mjs";
import { mirrorLocal } from "../scripts/site-release/targets.mjs";
import { rootActivate, rootUndo, rootResult, rootStatus, rootCancel, lockRoot } from "../scripts/site-release/root-state.mjs";
import { rollout, resolve, targetIdentity } from "../scripts/site-release/rollout.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = path.join(REPO, "scripts/site-release/cli.mjs"), ROOT_STATE = path.join(REPO, "scripts/site-release/root-state.mjs");
const cspHash = (s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
const op = () => randomBytes(16).toString("hex");
let tmp, rel = {};
const dir = (n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; };
const write = (root, rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };
const link = (root) => { try { return fs.readlinkSync(path.join(root, "current")); } catch { return null; } };
const state = (root) => JSON.parse(fs.readFileSync(path.join(root, "state.json"), "utf8"));
const run = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, args, { env: { PATH: process.env.PATH, HOME: tmp, ...env } });
  let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("close", (code, signal) => resolve({ code, signal, out, err }));
});
const tool = (args) => run([TOOL, ...args]);
const until = async (f, what) => { for (let i = 0; i < 400; i++) { if (f()) return; await new Promise((r) => setTimeout(r, 25)); } throw new Error(`timed out waiting for ${what}`); };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-rollout-"));
  const inst = dir("cli"); for (const n of ["install.sh", "install.ps1", "host.ps1"]) write(inst, n, `# ${n}\n`);
  let base = null;
  for (const name of ["x", "y", "z"]) {
    const d = dir(`dist-${name}`);
    write(d, "index.html", `<script>${name}</script>${name}`); write(d, `js/chunks/${name}-AAAA.js`, name);
    write(d, "csp-script-src.txt", `script-src 'self' ${cspHash(name)};\n`);
    rel[name] = prepareRelease({ dist: d, installers: inst, out: dir("out"), ...(base ? { base } : { noBase: true }) });
    base = rel[name].dir;
  }
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// a local root holding every release, activatable without a server (activation = headers, swap; no probe)
async function root(name, activate = {}) {
  const t = { name, kind: "local-root", root: dir(`root-${name}`), activate };
  for (const r of Object.values(rel)) await mirrorLocal(t, r.dir);
  return t;
}
const targetsFile = (name, ts) => { const f = path.join(tmp, `${name}.json`); fs.writeFileSync(f, JSON.stringify({ version: 1, targets: ts.map((t) => ({ name: t.name, kind: t.kind, root: t.root, activate: t.activate })) })); return f; };

test("one root: identity, compare-and-swap, idempotent replay, fenced undo (A-B-A), tombstones, unknown CIDs", async () => {
  const t = await root("unit");
  const st = await rootStatus(t);
  assert.match(st.rootId, /^[0-9a-f]{32}$/); assert.deepEqual([st.generation, st.current], [0, null]);
  const rootId = st.rootId;
  await assert.rejects(rootActivate(t, { opId: op(), cid: rel.x.cid, expectGeneration: 0, rootId: "f".repeat(32) }), /not ffff/, "another root id refuses");
  assert.equal((await rootActivate(t, { opId: op(), cid: rel.x.cid, expectGeneration: 1, rootId })).outcome, "refused", "a stale generation is refused");
  const a = op(), ra = await rootActivate(t, { opId: a, cid: rel.x.cid, expectGeneration: 0, rootId });
  assert.deepEqual([ra.outcome, ra.generation, link(t.root)], ["committed", 1, rel.x.cid]);
  assert.equal((await rootActivate(t, { opId: a, cid: rel.x.cid, expectGeneration: 0, rootId })).replay, true, "a replayed opId never runs twice");
  // A-B-A: B activates y, C activates x again; A's undo must NOT touch C's x even though the CID is the same
  const b = op(), c = op();
  assert.equal((await rootActivate(t, { opId: b, cid: rel.y.cid, expectGeneration: 1, rootId })).outcome, "committed");
  assert.equal((await rootActivate(t, { opId: c, cid: rel.x.cid, expectGeneration: 2, rootId })).outcome, "committed");
  assert.deepEqual([(await rootUndo(t, { opId: a, attempt: 1, rootId })).outcome, link(t.root), state(t.root).generation], ["superseded", rel.x.cid, 3]);
  const uc = await rootUndo(t, { opId: c, attempt: 1, rootId });
  assert.deepEqual([uc.outcome, uc.generation, link(t.root)], ["committed", 4, rel.y.cid], "an undo is a new generation, never a rewind");
  assert.equal((await rootUndo(t, { opId: c, attempt: 2, rootId })).replay, true, "a later attempt after a committed one returns it");
  // cancel: a tombstone for an operation that never ran; the same operation arriving later finds it and does not run
  const late = op();
  assert.equal((await rootCancel(t, { opId: late, rootId })).outcome, "cancelled");
  const arrived = await rootActivate(t, { opId: late, cid: rel.z.cid, expectGeneration: 4, rootId });
  assert.deepEqual([arrived.outcome, arrived.replay, link(t.root), state(t.root).generation], ["cancelled", true, rel.y.cid, 4]);
  assert.equal((await rootCancel(t, { opId: b, rootId })).outcome, "committed", "cancel of an operation that ran returns its result");
  assert.equal((await rootResult(t, { opId: op(), rootId })).outcome, "unknown-op");
  const unknown = await rootActivate(t, { opId: op(), cid: "b" + "a".repeat(58), expectGeneration: 4, rootId });
  assert.match(unknown.reason, /not present and verified/); assert.equal(link(t.root), rel.y.cid);
});

test("the coordinator's late activation: resolve cancels the lost send durably, and the late arrival cannot commit (both race orders)", async () => {
  const run1 = async (lateFirst) => {
    const t = await root(`late-${lateFirst ? "wins" : "loses"}`);
    const st0 = await rootStatus(t);
    await rootActivate(t, { opId: op(), cid: rel.x.cid, expectGeneration: 0, rootId: st0.rootId });
    const st = await rootStatus(t), opId = op(), rolloutId = op(), jdir = dir(`journal-late-${lateFirst}`);
    // the journal a real rollout writes before sending: "sent", bound to the target's identity and root id
    const journal = path.join(jdir, `${rolloutId}.json`);
    fs.writeFileSync(journal, JSON.stringify({ v: 2, rolloutId, cid: rel.y.cid, targets: [{ name: t.name, kind: t.kind, identity: targetIdentity(t),
      state: "sent", rootId: st.rootId, opId, expectGeneration: st.generation, previous: st.current }] }));
    if (lateFirst) await rootActivate(t, { opId, cid: rel.y.cid, expectGeneration: st.generation, rootId: st.rootId });   // it won the race
    const settled = await resolve([t], journal);
    if (!lateFirst) {
      assert.deepEqual([settled.status, settled.targets[0].state], ["reverted", "cancelled"]);
      const late = await rootActivate(t, { opId, cid: rel.y.cid, expectGeneration: st.generation, rootId: st.rootId });
      assert.deepEqual([late.outcome, late.replay], ["cancelled", true], "the delayed activation finds its tombstone and does not run");
      assert.deepEqual([link(t.root), state(t.root).generation], [rel.x.cid, 1], "the root never left x");
    } else {
      assert.deepEqual([settled.status, settled.targets[0].state], ["active", "committed"], "cancel returns the result of the activation that won");
      assert.equal(link(t.root), rel.y.cid);
    }
  };
  await run1(false); await run1(true);
});

// two REAL processes contending for one root's lock. The legacy algorithm (pid file + liveness check + rmSync) is run
// verbatim with a pause before its rmSync: both processes see the same dead pid, and both end up "holding" the lock.
const LEGACY = `import fs from "node:fs"; import path from "node:path";
const [root, gate, out] = process.argv.slice(2), lock = path.join(root, ".site-release.lock");   // gate: this process's own
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
for (let attempt = 0; ; attempt++) {
  try { const fd = fs.openSync(lock, "wx"); fs.writeSync(fd, process.pid + " legacy\\n"); fs.closeSync(fd); break; }
  catch (e) {
    const pid = Number(fs.readFileSync(lock, "utf8").split(" ")[0]);
    if (attempt === 0 && !alive(pid)) {
      fs.writeFileSync(out + ".paused", ""); while (!fs.existsSync(gate)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      fs.rmSync(lock, { force: true }); continue;
    }
    fs.writeFileSync(out, "refused"); process.exit(0);
  }
}
fs.writeFileSync(out, "acquired"); setTimeout(() => {}, 1500);`;
const HOLDER = `import { lockRoot } from ${JSON.stringify(ROOT_STATE)}; import fs from "node:fs";
const [root, out, hold] = process.argv.slice(2);
// it never releases explicitly: holding until it EXITS (or is killed) is exactly what the kernel must clean up
try { await lockRoot(root, { wait: Number(process.env.WAIT || 0) }); fs.writeFileSync(out, "acquired " + Date.now()); setTimeout(() => process.exit(0), Number(hold)); }
catch (e) { fs.writeFileSync(out, "refused: " + e.message); }`;

test("lock: the legacy pid takeover lets two real processes hold a root at once; the kernel lock never does, and survives crashes", async () => {
  const legacy = path.join(tmp, "legacy.mjs"), holder = path.join(tmp, "holder.mjs");
  fs.writeFileSync(legacy, LEGACY); fs.writeFileSync(holder, HOLDER);
  // legacy: a lock file of a dead pid; A and B both pass the liveness check, pause before rmSync, then race
  const L = dir("legacy-root");
  const dead = await run(["-e", "process.stdout.write(String(process.pid))"]);
  fs.writeFileSync(path.join(L, ".site-release.lock"), `${dead.out} dead\n`);
  const outs = [path.join(tmp, "legacy-a"), path.join(tmp, "legacy-b")];
  const ps = outs.map((o) => run([legacy, L, o + ".gate", o]));
  await until(() => outs.every((o) => fs.existsSync(o + ".paused")), "both legacy processes to pause before rmSync");
  // A goes first: removes the dead lock and creates its own; only then is B released: it removes A's NEW lock and
  // creates a second one, while A still believes it holds the lock
  fs.writeFileSync(outs[0] + ".gate", "");
  await until(() => fs.existsSync(outs[0]), "A to report");
  fs.writeFileSync(outs[1] + ".gate", "");
  await Promise.all(ps);
  assert.deepEqual(outs.map((o) => fs.readFileSync(o, "utf8")).sort(), ["acquired", "acquired"], "the legacy algorithm granted the lock twice");
  // the kernel lock: B is refused while A holds it (however often it asks), and gets it once A is SIGKILLed
  const K = dir("kernel-root");
  fs.writeFileSync(path.join(K, ".site-release.lock"), `${dead.out} dead\n`);   // a dead pid in the file is irrelevant now
  const a = spawn(process.execPath, [holder, K, path.join(tmp, "k-a"), "60000"], { stdio: "ignore" });
  try {
  await until(() => fs.existsSync(path.join(tmp, "k-a")), "A to hold the kernel lock");
  for (let i = 0; i < 5; i++) {
    const b = await run([holder, K, path.join(tmp, `k-b${i}`), "0"]);
    assert.equal(b.code, 0); assert.match(fs.readFileSync(path.join(tmp, `k-b${i}`), "utf8"), /^refused: .*locked by another release run/);
  }
  const waiting = run([holder, K, path.join(tmp, "k-c"), "0"], { WAIT: "20" });   // C waits for the lock
  a.kill("SIGKILL");                                                              // A crashes while holding it
  await waiting;
  assert.match(fs.readFileSync(path.join(tmp, "k-c"), "utf8"), /^acquired/, "the kernel released the crashed holder's lock");
  assert.ok(fs.existsSync(path.join(K, ".site-release.lock")), "the lock file (inode) is never removed");
  } finally { a.kill("SIGKILL"); }
});

test("history is published atomically: a crash between state commit and history leaves no partial file and is repaired", async () => {
  const t = await root("atomic"), { rootId } = await rootStatus(t);
  const a = op();
  await rootActivate(t, { opId: a, cid: rel.x.cid, expectGeneration: 0, rootId });
  // simulate the crash window: the state committed (lastOp), the final history file never linked, a stray tmp behind
  fs.rmSync(path.join(t.root, "ops", `${a}.json`));
  fs.writeFileSync(path.join(t.root, "ops", `.tmp-${a}-dead`), '{"opId":"' + a.slice(0, 10));
  const r = await rootCancel(t, { opId: a, rootId });
  assert.deepEqual([r.outcome, r.replay], ["committed", true], "the result comes back from state.lastOp, never a tombstone");
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.root, "ops", `${a}.json`), "utf8")).outcome, "committed");
  assert.deepEqual(fs.readdirSync(path.join(t.root, "ops")).filter((n) => n.startsWith(".tmp-")), [], "the partial tmp is gone");
});

test("a rollback whose reload fails is PENDING (never claimed restored) until a later operation confirms it", async () => {
  const flag = path.join(tmp, "reload-fails"), script = path.join(tmp, "reload.mjs");
  fs.writeFileSync(script, `import fs from "node:fs"; if (fs.existsSync(${JSON.stringify(flag)})) { console.error("reload refused"); process.exit(1); }`);
  const t = await root("reload", { reload: [process.execPath, script] });
  const { rootId } = await rootStatus(t);
  await rootActivate(t, { opId: op(), cid: rel.x.cid, expectGeneration: 0, rootId });
  fs.writeFileSync(flag, "");   // the server cannot reload: the activation fails, and so does the reload of its rollback
  const a = op(), r = await rootActivate(t, { opId: a, cid: rel.y.cid, expectGeneration: 1, rootId });
  assert.equal(r.outcome, "pending"); assert.match(r.reason, /could not be confirmed/);
  assert.equal(state(t.root).pending.restore.to, rel.x.cid);
  assert.equal((await rootStatus(t)).pending, true);
  await assert.rejects(rootActivate(t, { opId: op(), cid: rel.z.cid, expectGeneration: 1, rootId }), /stays pending/, "nothing new runs until it is confirmed");
  assert.equal((await rootCancel(t, { opId: a, rootId })).outcome, "pending", "cancel does not pretend it settled");
  fs.rmSync(flag);              // the server is fixed
  const settled = await rootCancel(t, { opId: a, rootId });
  assert.deepEqual([settled.outcome, link(t.root), state(t.root).generation, state(t.root).pending], ["rolled-back", rel.x.cid, 1, null]);
});

test("identity: resolve refuses a same-name target that is not the journalled one, and a replaced root refuses the journal's root id", async () => {
  const a = await root("ida"), b = await root("idb");
  const jdir = dir("journal-id");
  const r = await rollout([a, b], rel.x.cid, { journalDir: jdir });
  assert.equal(r.status, "active");
  const journal = r.journal, j = JSON.parse(fs.readFileSync(journal, "utf8"));
  j.targets[1].state = "unknown"; fs.writeFileSync(journal, JSON.stringify(j));   // pretend b's outcome was lost
  // the same NAME, another root path: not settled, nothing touched
  const other = { ...b, root: dir("root-idb-elsewhere") };
  const refused = await resolve([a, other], journal);
  assert.equal(refused.status, "pending"); assert.match(refused.refused, /identity mismatch for idb/);
  // the same path, but the root was replaced (a new state, so a new root id): the root itself refuses
  fs.renameSync(b.root, b.root + ".old"); await mirrorLocal(b, rel.x.dir);
  const replaced = await resolve([a, b], journal);
  assert.equal(replaced.status, "pending"); assert.match(replaced.targets[1].detail, /identity: this root is [0-9a-f]{32}, not /);
  assert.equal(link(b.root), null, "the replacement root was not touched");
});

test("interleaved rollouts: B and C run while A is mid-rollout; A's later failure cannot undo theirs (A-B-A included)", async () => {
  const a = await root("ia"), b = await root("ib");
  const journalDir = dir("journal-interleave");
  assert.equal((await rollout([a, b], rel.x.cid, { journalDir })).status, "active");
  const ra = await rollout([a, b], rel.y.cid, { journalDir, hooks: { afterTarget: async (name) => {
    if (name !== "ia") return;
    assert.equal((await rollout([a, b], rel.z.cid, { journalDir })).status, "active");
    assert.equal((await rollout([a, b], rel.y.cid, { journalDir })).status, "active");
  } } });
  assert.equal(ra.status, "reverted");
  assert.deepEqual(ra.targets.map((x) => [x.name, x.state]), [["ia", "superseded"], ["ib", "refused"]]);
  assert.deepEqual([link(a.root), link(b.root)], [rel.y.cid, rel.y.cid], "both serve C's release, which C fully confirmed");
  assert.deepEqual([state(a.root).generation, state(b.root).generation], [4, 3], "A's undo changed nothing");
});

test("the orchestrator is KILLED mid-rollout: resolve in a new process restores the interrupted root and reverts the rest", async () => {
  const killer = path.join(tmp, "kill-parent.mjs");
  fs.writeFileSync(killer, "process.kill(process.ppid, 'SIGKILL');\n");
  const a = await root("ka"), b = await root("kb");
  const plain = targetsFile("targets-kill", [{ ...a, activate: {} }, { ...b, activate: {} }]), journalDir = dir("journal-kill");
  assert.equal((await tool(["activate", "--release", rel.x.dir, "--targets", plain, "--approve", rel.x.cid, "--journal", journalDir])).code, 0);
  const killing = targetsFile("targets-kill2", [{ ...a, activate: {} }, { ...b, activate: { reload: [process.execPath, killer] } }]);
  const killed = await tool(["activate", "--release", rel.y.dir, "--targets", killing, "--approve", rel.y.cid, "--journal", journalDir]);
  assert.equal(killed.signal, "SIGKILL", "the orchestrator died mid-change on b");
  const id = fs.readdirSync(journalDir).map((f) => JSON.parse(fs.readFileSync(path.join(journalDir, f), "utf8"))).find((j) => j.cid === rel.y.cid).rolloutId;
  const left = JSON.parse(fs.readFileSync(path.join(journalDir, `${id}.json`), "utf8"));
  assert.deepEqual(left.targets.map((x) => [x.name, x.state]), [["ka", "committed"], ["kb", "sent"]]);
  assert.equal(state(b.root).pending.cid, rel.y.cid);
  // the identity check compares configurations: b's journalled identity is its root path, unchanged by the reload change
  const r = await tool(["resolve", "--targets", plain, "--journal", journalDir, "--rollout", id]);
  assert.equal(r.code, 1, r.err + r.out); assert.match(r.err, /failed and was reverted/);
  assert.deepEqual(JSON.parse(r.out).targets.map((x) => [x.name, x.state]), [["ka", "undone"], ["kb", "rolled-back"]]);
  assert.deepEqual([link(a.root), link(b.root), state(b.root).pending], [rel.x.cid, rel.x.cid, null]);
  assert.equal(fs.readFileSync(path.join(b.root, "headers.caddy"), "utf8"), fs.readFileSync(path.join(rel.x.dir, "headers.caddy"), "utf8"));
  const r2 = await tool(["resolve", "--targets", plain, "--journal", journalDir, "--rollout", id]);
  assert.equal(r2.code, 1); assert.deepEqual([link(a.root), link(b.root), state(a.root).generation], [rel.x.cid, rel.x.cid, 3], "resolve is idempotent");
});
