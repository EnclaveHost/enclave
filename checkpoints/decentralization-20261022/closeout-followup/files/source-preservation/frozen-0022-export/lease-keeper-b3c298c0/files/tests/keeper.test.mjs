// The keeper's ACTUAL cycle (lib.mjs), entry (keeper-cycle.mjs) and loop (keeper-loop.sh) against fakes: no chain, guestd,
// relay, key or network. Fake clock; fake deps record the order of signing, journaling and the relay POST.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cycle, init, lock, attempts, adoption, PINS, EXIT } from "../lib.mjs";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [A, B] = Object.keys(PINS.apps), GA = PINS.apps[A], GB = PINS.apps[B];
const T0 = 1_792_800_000;
function world(over = {}) {
  const w = { t: T0, until: { [A]: T0 + 200, [B]: T0 + 1500 }, pol: { [A]: "Ready", [B]: "NotInRenewWindow" }, held: null,
    guests: { [A]: { status: "running", name: A, vm: GA }, [B]: { status: "running", name: B, vm: GB } }, events: [], renew: null, ...over };
  w.now = () => w.t;
  w.deps = {
    lease: async (id) => ({ active: true, runner: PINS.runner, runnerOperator: "0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB", leaseUntil: BigInt(w.until[id]) }),
    guest: async (id, vm) => ({ ...w.guests[id] }),
    availability: async () => w.held,
    policy: async (id) => ({ status: w.pol[id] }),
    renew: async (id, onSigned) => {
      if (w.renew) return w.renew(id, onSigned);
      w.events.push(`sign ${id.slice(0, 6)}`);
      await onSigned({ kind: "renew", lease: { id, maxChargeWei: 1_000_000n, nonce: 7n }, nonce: 7n, deadline: 1n });
      w.events.push(`post ${id.slice(0, 6)} intent=${fs.existsSync(path.join(w.dir, id, "001.intent.json"))}`);
      w.until[id] += 1800;
      return { hash: "0x" + "ab".repeat(32), chargedWei: "1262773885861" };
    },
  };
  w.dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-")); init(w.dir, w.t);
  w.run = () => cycle({ dir: w.dir, deps: w.deps, now: w.now });
  return w;
}

test("renews ONLY an app in its renew window, journaling the signed intent BEFORE the relay sees it; the verified receipt is the result", async () => {
  const w = world();
  const r = await w.run();
  assert.equal(r.code, EXIT.CONTINUE);
  assert.deepEqual(w.events, [`sign ${A.slice(0, 6)}`, `post ${A.slice(0, 6)} intent=true`]);
  const intent = JSON.parse(fs.readFileSync(path.join(w.dir, A, "001.intent.json"), "utf8"));
  assert.equal(intent.lease.id, A); assert.equal((fs.statSync(path.join(w.dir, A, "001.intent.json")).mode & 0o777), 0o600);
  const res = JSON.parse(fs.readFileSync(path.join(w.dir, A, "001.result.json"), "utf8"));
  assert.deepEqual([res.hash, res.chargedWei, res.receiptVerified, res.operatorEthSpent, res.leaseUntilAfter], ["0x" + "ab".repeat(32), "1262773885861", true, false, T0 + 2000]);
  assert.deepEqual(attempts(w.dir, B), [], "B is not in its window: nothing signed");
  assert.ok(!JSON.stringify(r).match(/key|sig(nature)?"/i));
});

test("an intent without a result STOPS every later cycle (reconcile, never re-sign)", async () => {
  const w = world({ renew: async (id, onSigned) => { await onSigned({ kind: "renew", lease: { id, maxChargeWei: 1n } }); throw Object.assign(new Error("relay timeout"), { code: "Unconfirmed" }); } });
  const r1 = await w.run();
  assert.equal(r1.code, EXIT.RECONCILE); assert.match(r1.why, /signed, outcome unknown/);
  let calls = 0; w.renew = async () => { calls++; return {}; };
  w.t += 600;
  const r2 = await w.run();
  assert.equal(r2.code, EXIT.RECONCILE); assert.equal(calls, 0, "nothing re-signed");
});

test("refused before signing (no intent) is transient; a signed lease outside scope is never journaled or sent", async () => {
  const w = world({ renew: async () => { throw Object.assign(new Error("Refused: NotInRenewWindow"), { code: "NotInRenewWindow" }); } });
  assert.equal((await w.run()).code, EXIT.TRANSIENT);
  assert.deepEqual(attempts(w.dir, A), []);
  for (const bad of [{ kind: "claim", lease: { id: A, maxChargeWei: 1n } }, { kind: "renew", lease: { id: B, maxChargeWei: 1n } },
                     { kind: "renew", lease: { id: A, maxChargeWei: BigInt(PINS.maxChargeWei) + 1n } }]) {
    const v = world(); let sent = false;
    v.renew = async (id, onSigned) => { await onSigned(bad); sent = true; return {}; };
    const r = await v.run();
    assert.equal(sent, false, JSON.stringify(bad, (k, x) => typeof x === "bigint" ? String(x) : x));
    assert.deepEqual(attempts(v.dir, A), []); assert.equal(r.code, EXIT.TRANSIENT);
  }
});

test("refuses (never renews) another runner/operator, an inactive lease, or a guest that is not the original one running", async () => {
  const cases = [
    (w) => { w.deps.lease = async () => ({ active: true, runner: "0x" + "11".repeat(32), runnerOperator: PINS.operator, leaseUntil: 1n }); },
    (w) => { w.deps.lease = async () => ({ active: true, runner: PINS.runner, runnerOperator: "0x" + "22".repeat(20), leaseUntil: 1n }); },
    (w) => { w.deps.lease = async () => ({ active: false, runner: PINS.runner, runnerOperator: PINS.operator, leaseUntil: 1n }); },
    (w) => { w.guests[A] = { status: "stopped", name: A, vm: GA }; },
    (w) => { w.guests[A] = { status: "running", name: B, vm: GA }; },
    (w) => { w.held = [{ id: A, vm: "gd00000000", status: "running", owned: true }]; }];
  for (const f of cases) { const w = world(); f(w); const r = await w.run(); assert.equal(r.code, EXIT.REFUSED, r.why); assert.deepEqual(w.events, []); }
});

test("finite: the 4 h TTL, root's STOP file and the 8-renewal cap end renewing", async () => {
  const w = world(); w.t = T0 + 4 * 3600;
  assert.equal((await w.run()).code, EXIT.DONE); assert.deepEqual(w.events, []);
  const s = world(); fs.writeFileSync(path.join(s.dir, "STOP"), "");
  assert.match((await s.run()).why, /root STOP/);
  const c = world();
  for (let n = 1; n <= 8; n++) { const f = String(n).padStart(3, "0"); fs.mkdirSync(path.join(c.dir, A), { recursive: true }); fs.writeFileSync(path.join(c.dir, A, `${f}.intent.json`), "{}"); fs.writeFileSync(path.join(c.dir, A, `${f}.result.json`), "{}"); }
  const r = await c.run();
  assert.equal(r.code, EXIT.CONTINUE); assert.deepEqual(c.events, []); assert.match(r.apps[A].why, /cap 8/);
  const p = world(); fs.writeFileSync(path.join(p.dir, "keeper.json"), JSON.stringify({ v: 1, startedAt: T0, ...PINS, maxRenewalsPerApp: 99 }));
  assert.equal((await p.run()).code, EXIT.REFUSED, "pins must be this keeper's");
});

test("stops only once the control ADOPTED both original guests AND renewed each itself; mere attachment or adoption is not enough", async () => {
  const w = world({ pol: { [A]: "Ready", [B]: "Ready" } });
  w.held = null;                                                        // attached but adopting nothing: keeper renews
  assert.equal((await w.run()).code, EXIT.CONTINUE); assert.equal(attempts(w.dir, A).length, 1);
  w.held = [{ id: A, vm: GA, status: "running", owned: true }, { id: B, vm: GB, status: "running", owned: true }];
  w.events.length = 0; w.t += 60;
  const r1 = await w.run();
  assert.equal(r1.code, EXIT.CONTINUE, "adopted, no normal renewal yet"); assert.deepEqual(w.events, [], "the keeper does not renew an adopted app");
  w.until[A] += 1800; w.t += 60;                                         // the control renews A
  assert.equal((await w.run()).code, EXIT.CONTINUE);
  w.until[B] += 1800; w.t += 60;                                         // and B
  const r3 = await w.run();
  assert.equal(r3.code, EXIT.DONE); assert.match(r3.why, /renewed both normally/);
  assert.equal(adoption([{ id: A, vm: GA, status: "starting", owned: true }], A, GA).adopted, false);
});

test("entry + lock: one cycle at a time (a live holder -> 6), a dead holder's lock is stale, nothing runs uninitialized", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-")); init(dir, Math.floor(Date.now() / 1000));
  const fake = path.join(dir, "fake-deps.mjs");
  fs.writeFileSync(fake, `export const deps = { lease: async () => ({ active: true, runner: "${PINS.runner}", runnerOperator: "${PINS.operator}", leaseUntil: 99999999999n }),
    guest: async (id, vm) => ({ status: "running", name: id, vm }), availability: async () => null, policy: async () => ({ status: "NotInRenewWindow" }),
    renew: async () => { throw new Error("must not renew"); } };`);
  const run = () => spawnSync(process.execPath, [path.join(HERE, "keeper-cycle.mjs")], { env: { ...process.env, KEEPER_STATE: dir, KEEPER_DEPS: fake }, encoding: "utf8", timeout: 30000 });
  fs.writeFileSync(path.join(dir, "cycle.lock"), String(process.pid));
  assert.equal(run().status, EXIT.BUSY);
  assert.equal(lock(dir, 1, () => false) !== null, true, "a dead holder's lock is replaced");
  fs.rmSync(path.join(dir, "cycle.lock"), { force: true });
  const ok = run(); assert.equal(ok.status, EXIT.CONTINUE, ok.stdout + ok.stderr);
  assert.ok(!fs.existsSync(path.join(dir, "cycle.lock")), "released");
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-"));
  assert.equal(spawnSync(process.execPath, [path.join(HERE, "keeper-cycle.mjs")], { env: { ...process.env, KEEPER_STATE: empty, KEEPER_DEPS: fake }, encoding: "utf8" }).status, EXIT.REFUSED);
});

test("loop: one instance; 98 retried only boundedly; stops on 3/4/10, continues on 0/5", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "keeper-loop-"));
  const script = path.join(dir, "fake-cycle.sh"), seq = path.join(dir, "seq");
  fs.writeFileSync(script, `#!/bin/bash\nn=$(cat ${seq}.n 2>/dev/null || echo 0); echo $((n+1)) > ${seq}.n\nc=$(sed -n "$((n+1))p" ${seq}); exit \${c:-10}\n`); fs.chmodSync(script, 0o755);
  const loop = (codes) => { fs.writeFileSync(seq, codes.join("\n") + "\n"); fs.rmSync(seq + ".n", { force: true });
    return spawnSync("bash", [path.join(HERE, "keeper-loop.sh")], { env: { ...process.env, KEEPER_STATE: dir, KEEPER_QUEUE: "env", KEEPER_CYCLE: script, KEEPER_SLEEP: "true" }, encoding: "utf8", timeout: 30000 }); };
  let r = loop([0, 5, 98, 0, 3]); assert.equal(r.status, 3); assert.equal(fs.readFileSync(seq + ".n", "utf8").trim(), "5");
  r = loop([0, 4]); assert.equal(r.status, 4);
  r = loop([10]); assert.equal(r.status, 10);
  r = loop(Array(40).fill(98).concat([10])); assert.equal(r.status, 10); assert.equal(fs.readFileSync(seq + ".n", "utf8").trim(), "41", "at most 40 tries of a not-started cycle, then the next cycle");
  fs.writeFileSync(seq, "98\n".repeat(400)); fs.rmSync(seq + ".n", { force: true });
  r = spawnSync("bash", [path.join(HERE, "keeper-loop.sh")], { env: { ...process.env, KEEPER_STATE: dir, KEEPER_QUEUE: "env", KEEPER_CYCLE: script, KEEPER_SLEEP: "true", KEEPER_LOOP_MAX_S: "1" }, encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 11, "a queue that never starts a cycle still ends at the loop deadline");
  const held = spawnSync("bash", ["-c", `exec 9>${dir}/loop.lock; flock -n 9; KEEPER_STATE=${dir} KEEPER_QUEUE=env KEEPER_CYCLE=${script} KEEPER_SLEEP=true bash ${path.join(HERE, "keeper-loop.sh")}; rc=$?; exit $rc`], { encoding: "utf8" });   // not exec'd: this shell keeps holding the lock
  assert.equal(held.status, 6, held.stdout);
});
