// The EXACT do-source-stop.sh / do-source-restore.sh against an isolated mock filesystem (FSROOT) and mock systemctl, pgrep,
// ss and curl (test/mockbin, first on PATH). The fixture is the source host as root verified it: the REVIEWED unit file
// (4b3e5ac7) at /etc/systemd/system, enabled and active; the reviewed relay.env (7c05d44a); a 0600 key; the send record under
// /var/lib/private. The mock systemctl refuses `mask` while a regular unit file is in place, as the real one did.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, "..");
const REVIEWED = path.resolve(ROOT, "../../lease-relay-activation/final-94f4ebdf");
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const CANARY = "c0ffee".repeat(10) + "abcd";   // the fixture key: its content must never appear in any output
const PENDING = JSON.stringify({ nonce: 7, raw: "0x02f86b82210507", hash: "0x" + "ab".repeat(32) });

function world({ state = "{}", unit = path.join(REVIEWED, "enclave-lease-relay-credential-copy.service") } = {}) {
  const fsroot = fs.mkdtempSync(path.join(os.tmpdir(), "relay-src-"));
  const p = (...x) => path.join(fsroot, ...x);
  for (const d of ["etc/systemd/system", "etc/enclave-lease-relay", "var/lib/enclave-lease-relay", "var/lib/private/enclave-lease-relay-state", "mock"]) fs.mkdirSync(p(d), { recursive: true });
  fs.copyFileSync(unit, p("etc/systemd/system/enclave-lease-relay.service"));
  fs.copyFileSync(path.join(REVIEWED, "relay.env"), p("etc/enclave-lease-relay/relay.env"));
  fs.writeFileSync(p("var/lib/enclave-lease-relay/relay.key"), "0x" + CANARY + "\n", { mode: 0o600 });
  fs.writeFileSync(p("var/lib/private/enclave-lease-relay-state/relay-send.json"), state, { mode: 0o600 });
  fs.writeFileSync(p("mock/active"), ""); fs.writeFileSync(p("mock/enabled"), "");
  const run = (script, ...args) => {
    const r = spawnSync("bash", [path.join(ROOT, script), ...args], { encoding: "utf8", timeout: 120_000,
      env: { PATH: `${path.join(HERE, "mockbin")}:${process.env.PATH}`, FSROOT: fsroot, HOME: fsroot } });
    const out = r.stdout + r.stderr;
    assert.ok(!out.includes(CANARY), "the key's content never appears in any output");
    return { code: r.status, out };
  };
  const unitPath = p("etc/systemd/system/enclave-lease-relay.service"), mig = p("var/lib/enclave-lease-relay-migration");
  const stateFile = p("var/lib/private/enclave-lease-relay-state/relay-send.json"), key = p("var/lib/enclave-lease-relay/relay.key");
  const snap = () => { const o = {}; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name);
    if (e.isSymbolicLink()) o[path.relative(fsroot, f)] = "-> " + fs.readlinkSync(f); else if (e.isDirectory()) walk(f); else if (!f.endsWith("mock/calls")) o[path.relative(fsroot, f)] = sha(f); } }; walk(fsroot); return o; };
  const masked = () => { try { return fs.readlinkSync(unitPath) === "/dev/null"; } catch { return false; } };
  return { fsroot, p, run, unitPath, mig, stateFile, key, snap, masked, active: () => fs.existsSync(p("mock/active")), enabled: () => fs.existsSync(p("mock/enabled")),
    inject: (name) => fs.writeFileSync(p("mock", name), ""), clear: (name) => fs.rmSync(p("mock", name), { force: true }), done: () => fs.rmSync(fsroot, { recursive: true, force: true }) };
}
const UNIT_SHA = "4b3e5ac7b384911aec0995bc42d255c1b503197935aa24f5945984fd4e09b6ba";
const gate = (dir, code) => { const f = path.join(dir, `gate-${code}.mjs`); fs.writeFileSync(f, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(dir, "gate-saw.json"))}, JSON.stringify(process.env)); process.exit(${code});`); return f; };

test("the reviewed fixture: the unit file and relay.env are the reviewed bytes", () => {
  assert.equal(sha(path.join(REVIEWED, "enclave-lease-relay-credential-copy.service")), UNIT_SHA);
  assert.equal(sha(path.join(REVIEWED, "relay.env")), "7c05d44ad8b0ad2777d73af8cb7895c6dbb8abd040ce8e5cb36e8d466b0d6769");
});

test("--check is read-only and reports every precondition; it refuses a changed unit, a missing record or an earlier run", () => {
  const w = world({ state: PENDING });
  try {
    const before = w.snap(), r = w.run("do-source-stop.sh", "--check");
    assert.equal(r.code, 0, r.out); assert.match(r.out, /CHECK OK/); assert.match(r.out, /UNRESOLVED nonce 7 hash 0xabab/); assert.match(r.out, /TEST ROOT/);
    assert.deepEqual(w.snap(), before, "nothing changed"); assert.ok(w.active());
    fs.appendFileSync(w.unitPath, "# edited\n");
    let c = w.run("do-source-stop.sh", "--stop"); assert.equal(c.code, 2); assert.match(c.out, /not the reviewed/); assert.match(c.out, /NOTHING CHANGED/);
    assert.ok(w.active() && w.enabled() && !fs.existsSync(w.mig), "a CAS mismatch changes nothing");
  } finally { w.done(); }
  const w2 = world(); try {
    fs.rmSync(w2.stateFile); let c = w2.run("do-source-stop.sh", "--stop"); assert.equal(c.code, 2); assert.match(c.out, /send record is absent/);
    fs.writeFileSync(w2.stateFile, "{}"); fs.mkdirSync(w2.mig); c = w2.run("do-source-stop.sh", "--stop"); assert.equal(c.code, 2); assert.match(c.out, /already exists/);
    assert.ok(w2.active());
  } finally { w2.done(); }
  const w3 = world(); try { fs.chmodSync(w3.key, 0o644); const c = w3.run("do-source-stop.sh", "--stop"); assert.equal(c.code, 2); assert.match(c.out, /key file is not/); } finally { w3.done(); }
});

test("--stop: rollback copy, stop, disable, unit file moved aside, persistent mask; key and record untouched; a second run refuses", () => {
  const w = world({ state: PENDING });
  try {
    const keySha = sha(w.key), stateSha = sha(w.stateFile);
    const r = w.run("do-source-stop.sh", "--stop");
    assert.equal(r.code, 0, r.out); assert.match(r.out, /SOURCE STOPPED \(masked/);
    assert.ok(!w.active() && !w.enabled() && w.masked(), "inactive, disabled, masked");
    assert.equal(sha(path.join(w.mig, "unit.rollback")), UNIT_SHA); assert.equal(sha(path.join(w.mig, "unit.moved")), UNIT_SHA);
    assert.equal((fs.statSync(w.mig).mode & 0o777), 0o700);
    assert.equal(sha(w.key), keySha); assert.equal(sha(w.stateFile), stateSha, "the key and the record are never moved or changed");
    const receipt = JSON.parse(fs.readFileSync(path.join(w.mig, "stop-receipt.json"), "utf8"));
    assert.deepEqual([receipt.masked, receipt.keyMoved, receipt.stateSha256, receipt.unitSha256, receipt.preStopStateSha256, receipt.journalChangedDuringStop], [true, false, stateSha, UNIT_SHA, stateSha, false]);
    assert.match(receipt.stateShape, /UNRESOLVED nonce 7/);
    const calls = fs.readFileSync(w.p("mock/calls"), "utf8").split("\n").map((l) => l.split(" ")[0]).filter((v) => v !== "show" && v);
    assert.deepEqual(calls, ["stop", "disable", "daemon-reload", "mask", "daemon-reload"], "the verbs, in that order");
    const again = w.run("do-source-stop.sh", "--stop"); assert.equal(again.code, 2);
    const st = w.run("do-source-stop.sh", "--check"); assert.equal(st.code, 2, "after the stop, --check says it is not a fresh source");
  } finally { w.done(); }
});

test("the mask is refused while the unit FILE is in place (the real systemd behaviour): that is why the file moves first", () => {
  const w = world();
  try {
    const r = spawnSync(path.join(HERE, "mockbin/systemctl"), ["mask", "enclave-lease-relay.service"], { env: { ...process.env, FSROOT: w.fsroot }, encoding: "utf8" });
    assert.equal(r.status, 1); assert.match(r.stderr, /File exists/); assert.ok(!w.masked());
  } finally { w.done(); }
});

test("every intermediate failure fails CLOSED (never restarts) and --abort-before-transfer restores the exact reviewed unit", () => {
  for (const [why, setup, step, after] of [
    ["stop does not take", (w) => w.inject("stuck-stop"), /step 2: the unit is still active/, (w) => { assert.ok(w.active()); assert.equal(sha(w.unitPath), UNIT_SHA); }],
    ["the https front still answers as the payee", (w) => w.inject("front-still-serves"), /step 2: something still answers/, (w) => { assert.ok(!w.active()); }],
    ["disable fails", (w) => w.inject("fail-disable"), /step 3/, (w) => { assert.ok(!w.active() && w.enabled() && fs.existsSync(w.unitPath)); }],
    ["daemon-reload fails after the move", (w) => w.inject("fail-daemon-reload"), /step 5: daemon-reload failed/, (w) => { assert.ok(!fs.existsSync(w.unitPath) && !w.masked()); }],
    ["mask fails after the move", (w) => w.inject("fail-mask"), /step 5: systemctl mask failed/, (w) => { assert.ok(!fs.existsSync(w.unitPath)); assert.equal(sha(path.join(w.mig, "unit.moved")), UNIT_SHA); }],
  ]) {
    const w = world();
    try {
      setup(w);
      const r = w.run("do-source-stop.sh", "--stop");
      assert.equal(r.code, 1, `${why}: ${r.out}`); assert.match(r.out, step, why); assert.match(r.out, /NOT restarted/);
      after(w);
      assert.ok(!fs.readFileSync(w.p("mock/calls"), "utf8").split("\n").some((l) => l.startsWith("start")), `${why}: nothing started`);
      for (const f of ["stuck-stop", "front-still-serves", "fail-disable", "fail-daemon-reload", "fail-mask"]) w.clear(f);
      const back = w.run("do-source-restore.sh", "--abort-before-transfer");
      assert.equal(back.code, 0, `${why}: ${back.out}`);
      assert.ok(w.active() && w.enabled() && !w.masked(), `${why}: running again`);
      assert.equal(sha(w.unitPath), UNIT_SHA, `${why}: the exact reviewed unit`);
    } finally { w.done(); }
  }
});

test("--abort-before-transfer after a full stop: unmask, put the unit back (CAS), enable, start; refused if the record changed or a target record came back", () => {
  const w = world({ state: PENDING });
  try {
    assert.equal(w.run("do-source-stop.sh", "--stop").code, 0);
    fs.writeFileSync(w.stateFile, "{}");                       // as if the key had sent from somewhere since the stop
    let r = w.run("do-source-restore.sh", "--abort-before-transfer"); assert.equal(r.code, 2); assert.match(r.out, /differs from the STOPPED journal/);
    assert.ok(w.masked() && !w.active(), "refused: still masked");
    fs.writeFileSync(w.stateFile, PENDING);
    fs.writeFileSync(w.stateFile + ".from-windows", "{}");
    r = w.run("do-source-restore.sh", "--abort-before-transfer"); assert.equal(r.code, 2); assert.match(r.out, /use --after-target-start/);
    fs.rmSync(w.stateFile + ".from-windows");
    r = w.run("do-source-restore.sh", "--abort-before-transfer"); assert.equal(r.code, 0, r.out); assert.match(r.out, /RESTORED \(--abort-before-transfer\)/);
    assert.ok(w.active() && w.enabled() && !w.masked()); assert.equal(sha(w.unitPath), UNIT_SHA);
    assert.ok(fs.existsSync(path.join(w.mig, "unit.moved")) && fs.existsSync(path.join(w.mig, "unit.rollback")), "the copies are kept");
    const again = w.run("do-source-restore.sh", "--abort-before-transfer");
    assert.equal(again.code, 0, again.out); assert.match(again.out, /NOTHING TO RESTORE/, "idempotent: already running from the reviewed unit");
  } finally { w.done(); }
});

test("restore refuses a unit path holding ANY other file, and a tampered protected copy", () => {
  const v = world();
  try {
    assert.equal(v.run("do-source-stop.sh", "--stop").code, 0);
    fs.rmSync(v.unitPath); fs.writeFileSync(v.unitPath, "[Service]\nExecStart=/bin/other\n");
    let r = v.run("do-source-restore.sh", "--abort-before-transfer"); assert.equal(r.code, 1); assert.match(r.out, /holds another file/);
    assert.equal(fs.readFileSync(v.unitPath, "utf8"), "[Service]\nExecStart=/bin/other\n", "not overwritten");
    fs.rmSync(v.unitPath); fs.appendFileSync(path.join(v.mig, "unit.rollback"), "#x");
    r = v.run("do-source-restore.sh", "--abort-before-transfer"); assert.equal(r.code, 2); assert.match(r.out, /unit.rollback is missing or not the reviewed unit/);
    assert.ok(!v.active());
  } finally { v.done(); }
});

test("--after-target-start: needs the explicit out-of-service attestation, the returned record and a PASSING gate; then installs it, keeping the old one", () => {
  const w = world({ state: PENDING });
  const g = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  try {
    assert.equal(w.run("do-source-stop.sh", "--stop").code, 0);
    let r = w.run("do-source-restore.sh", "--after-target-start", gate(g, 0)); assert.equal(r.code, 2, "no attestation");
    r = w.run("do-source-restore.sh", "--after-target-start", "--windows-out-of-service", gate(g, 0)); assert.equal(r.code, 2); assert.match(r.out, /from-windows is absent/);
    const returned = JSON.stringify({ nonce: 9, raw: "0x02f86b82210509", hash: "0x" + "cd".repeat(32) });
    fs.writeFileSync(w.stateFile + ".from-windows", returned);
    r = w.run("do-source-restore.sh", "--after-target-start", "--windows-out-of-service", gate(g, 1)); assert.equal(r.code, 2); assert.match(r.out, /gate did not pass/);
    assert.equal(fs.readFileSync(w.stateFile, "utf8"), PENDING, "a failing gate changes nothing"); assert.ok(w.masked() && !w.active());
    r = w.run("do-source-restore.sh", "--after-target-start", "--windows-out-of-service", gate(g, 0)); assert.equal(r.code, 0, r.out);
    // the gate's environment is EXACTLY: PATH, this host's public relay.env names, the protected original key path, the record
    const saw = JSON.parse(fs.readFileSync(path.join(g, "gate-saw.json"), "utf8"));
    assert.deepEqual(Object.keys(saw).filter((k) => k !== "PATH").sort(), ["LEASE_RELAY_DIGEST", "LEASE_RELAY_EXPECTED_PAYEE", "LEASE_RELAY_KEY_FILE", "LEASE_RELAY_MAX_FLOAT_ETH",
      "LEASE_RELAY_MIN_FLOAT_ETH", "LEASE_RELAY_QUORUM", "LEASE_RELAY_RECORD", "LEASE_RELAY_RPCS", "LEASE_RELAY_STATE"], "nothing inherited (no FSROOT, HOME, LISTEN or ARTIFACT)");
    assert.equal(saw.LEASE_RELAY_KEY_FILE, w.key, "the PERSISTENT protected original key, not the unit's runtime credential copy");
    assert.doesNotMatch(saw.LEASE_RELAY_KEY_FILE, /enclave-lease-relay-credentials|\/run\//);
    assert.equal(saw.LEASE_RELAY_STATE, w.stateFile + ".from-windows"); assert.equal(saw.LEASE_RELAY_EXPECTED_PAYEE, "0x51ff183da8fF3b2dE08Da88331EED65e2F6A835c");
    assert.match(saw.LEASE_RELAY_RPCS, /^https:\/\/base-rpc\.publicnode\.com,/, "THIS host's relay.env, not the target's settings");
    assert.equal(saw.LEASE_RELAY_DIGEST, "sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089");
    assert.equal(fs.readFileSync(w.stateFile, "utf8"), returned, "the target's journal is the key's journal again");
    assert.equal(fs.readFileSync(path.join(w.mig, "relay-send.json.before-restore"), "utf8"), PENDING, "the source's own record is kept");
    assert.ok(w.active() && w.enabled() && !w.masked()); assert.equal(sha(w.unitPath), UNIT_SHA);
  } finally { w.done(); fs.rmSync(g, { recursive: true, force: true }); }
});

test("a stop that failed at step 2 left the relay running from its own unit: --abort-before-transfer says there is nothing to restore", () => {
  const w = world();
  try {
    w.inject("stuck-stop");
    assert.equal(w.run("do-source-stop.sh", "--stop").code, 1);
    const r = w.run("do-source-restore.sh", "--abort-before-transfer");
    assert.equal(r.code, 0, r.out); assert.match(r.out, /NOTHING TO RESTORE/); assert.ok(w.active());
  } finally { w.done(); }
});

test("an in-flight send settles DURING the stop: the receipt and both rollbacks use the STOPPED journal; the pre-stop sha is audit only", () => {
  const settled = JSON.stringify({});        // the pending send was mined while the relay stopped: the relay cleared its record
  for (const mode of ["abort", "after"]) {
    const w = world({ state: PENDING }); const g = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
    try {
      fs.writeFileSync(w.p("mock/stop-writes-state"), settled);
      const pre = sha(w.stateFile);
      const r = w.run("do-source-stop.sh", "--stop"); assert.equal(r.code, 0, r.out); assert.match(r.out, /settled during the stop/);
      const receipt = JSON.parse(fs.readFileSync(path.join(w.mig, "stop-receipt.json"), "utf8"));
      assert.equal(receipt.preStopStateSha256, pre); assert.equal(receipt.stateSha256, sha(w.stateFile)); assert.notEqual(receipt.stateSha256, pre);
      assert.equal(receipt.journalChangedDuringStop, true); assert.equal(receipt.stateShape, "nothing unresolved");
      assert.equal(fs.readFileSync(path.join(w.mig, "state-at-stop.sha256"), "utf8").trim(), sha(w.stateFile));
      if (mode === "abort") {
        const b = w.run("do-source-restore.sh", "--abort-before-transfer"); assert.equal(b.code, 0, b.out); assert.match(b.out, /is the stopped journal/);
        assert.equal(fs.readFileSync(w.stateFile, "utf8"), settled, "the source's own settled record is kept");
      } else {
        fs.writeFileSync(w.stateFile + ".from-windows", JSON.stringify({ nonce: 9, raw: "0x02f86b82210509", hash: "0x" + "cd".repeat(32) }));
        const b = w.run("do-source-restore.sh", "--after-target-start", "--windows-out-of-service", gate(g, 0)); assert.equal(b.code, 0, b.out);
        assert.equal(fs.readFileSync(path.join(w.mig, "relay-send.json.before-restore"), "utf8"), settled, "the preserved record is the STOPPED journal");
      }
      assert.ok(w.active() && !w.masked());
    } finally { w.done(); fs.rmSync(g, { recursive: true, force: true }); }
  }
});

test("a stop that failed BEFORE its journal was captured: no receipt, no fabricated sha; the abort proves the relay stopped and keeps its own record", () => {
  const w = world({ state: PENDING });
  try {
    w.inject("front-still-serves"); fs.writeFileSync(w.p("mock/stop-writes-state"), "{}");
    const r = w.run("do-source-stop.sh", "--stop");
    assert.equal(r.code, 1); assert.match(r.out, /no stopped journal was captured/);
    assert.ok(!fs.existsSync(path.join(w.mig, "state-at-stop.sha256")) && !fs.existsSync(path.join(w.mig, "stop-receipt.json")), "nothing fabricated");
    let b = w.run("do-source-restore.sh", "--after-target-start", "--windows-out-of-service", "/nonexistent-gate.mjs");
    assert.equal(b.code, 2); assert.match(b.out, /no completed stop/, "the key cannot have run on the target");
    b = w.run("do-source-restore.sh", "--abort-before-transfer");
    assert.equal(b.code, 2); assert.match(b.out, /still answers/, "something still answers as the payee: refused");
    w.clear("front-still-serves");
    b = w.run("do-source-restore.sh", "--abort-before-transfer");
    assert.equal(b.code, 0, b.out); assert.match(b.out, /authoritative journal/);
    assert.equal(fs.readFileSync(w.stateFile, "utf8"), "{}", "the relay's own (settled) record is kept, not overwritten");
    assert.equal(fs.readFileSync(path.join(w.mig, "state-authority-at-abort.sha256"), "utf8").trim(), sha(w.stateFile));
    assert.ok(w.active());
  } finally { w.done(); }
});

test("restore rechecks relay.env and the key BEFORE any write: a changed relay.env refuses and changes nothing", () => {
  const w = world();
  try {
    assert.equal(w.run("do-source-stop.sh", "--stop").code, 0);
    const before = w.snap();
    fs.appendFileSync(w.p("etc/enclave-lease-relay/relay.env"), "LEASE_RELAY_RPCS=https://evil.example\n");
    const b = w.run("do-source-restore.sh", "--abort-before-transfer");
    assert.equal(b.code, 2); assert.match(b.out, /relay.env is not the reviewed bytes/);
    const after = w.snap(); delete after["etc/enclave-lease-relay/relay.env"]; delete before["etc/enclave-lease-relay/relay.env"];
    delete after["var/lib/enclave-lease-relay-migration/progress.log"]; delete before["var/lib/enclave-lease-relay-migration/progress.log"];
    assert.deepEqual(after, before, "nothing else changed"); assert.ok(w.masked() && !w.active());
  } finally { w.done(); }
});
