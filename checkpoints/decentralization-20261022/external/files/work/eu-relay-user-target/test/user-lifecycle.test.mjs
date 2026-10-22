// The EXACT user-target scripts (user/) with the eu-central source's EXACT tested root scripts (source/), on isolated mock
// hosts: the source (FSROOT, as installed from the reviewed kit) and this user's target (TEST_TARGET_ROOT, TEST_UNIT_DIR),
// with mock systemctl (--user and system), curl, pgrep, ss, ip, ssh and scp (test/mockbin). The release is the REAL frozen
// release archive (../release/<id>.tar): staging extracts and verifies it and validates the configuration with its own copy
// of the role. The migration gate is a stub recording its environment (TEST_GATE; its logic is main's, tested there).
// Nothing real is touched: no unit of this user, no :8549, no network. The fixture key never appears in any output.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), WS = path.resolve(HERE, ".."), USER = path.join(WS, "user"), SRCS = path.join(WS, "source");
const KIT = path.resolve(WS, "../lease-relay-activation/final-94f4ebdf"), TESTED = path.resolve(WS, "../eu-relay-host-role-migration/root");
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const shaB = (b) => createHash("sha256").update(b).digest("hex");
const CANARY = "c0ffee".repeat(10) + "abcd";
const PAYEE = "0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a";
const PENDING = JSON.stringify({ nonce: 7, raw: "0x02f86b82210507", hash: "0x" + "ab".repeat(32) });
const LATER = JSON.stringify({ nonce: 9, raw: "0x02f86b82210509", hash: "0x" + "cd".repeat(32) });
const SRC_UNIT_SHA = "4b3e5ac7b384911aec0995bc42d255c1b503197935aa24f5945984fd4e09b6ba";
const T = { timeout: 180_000 };
const TAR = (() => { const d = path.join(WS, "release"); const t = fs.readdirSync(d).filter((f) => /^[0-9a-f]{64}\.tar$/.test(f)); assert.equal(t.length, 1, "one frozen release"); return path.join(d, t[0]); })();
const TAR_SHA = sha(TAR), REL_ID = path.basename(TAR, ".tar");
// a disk-backed scratch area (not /tmp: the tests copy a 70+ MiB release)
const SCRATCH = fs.mkdtempSync(path.join(WS, ".test-"));
process.on("exit", () => fs.rmSync(SCRATCH, { recursive: true, force: true }));

function source({ state = PENDING } = {}) {
  const r = fs.mkdtempSync(path.join(SCRATCH, "src-")), p = (...x) => path.join(r, ...x);
  for (const d of ["etc/systemd/system", "etc/enclave-lease-relay", "var/lib/enclave-lease-relay", "var/lib/private/enclave-lease-relay-state", "mock"]) fs.mkdirSync(p(d), { recursive: true });
  fs.copyFileSync(path.join(KIT, "enclave-lease-relay-credential-copy.service"), p("etc/systemd/system/enclave-lease-relay.service"));
  fs.copyFileSync(path.join(KIT, "relay.env"), p("etc/enclave-lease-relay/relay.env"));   // the reviewed kit's bytes, opaque here
  fs.writeFileSync(p("var/lib/enclave-lease-relay/relay.key"), "0x" + CANARY + "\n", { mode: 0o600 });
  const st = p("var/lib/private/enclave-lease-relay-state/relay-send.json"); fs.writeFileSync(st, state, { mode: 0o600 });
  fs.writeFileSync(p("mock/state-path"), st);
  for (const f of ["active-enclave-lease-relay.service", "enabled-enclave-lease-relay.service"]) fs.writeFileSync(p("mock", f), "");
  return { r, p, state: st, key: p("var/lib/enclave-lease-relay/relay.key"), mig: p("var/lib/enclave-lease-relay-migration"), unit: p("etc/systemd/system/enclave-lease-relay.service"),
    active: () => fs.existsSync(p("mock/active-enclave-lease-relay.service")) };
}
function target() {
  const r = fs.mkdtempSync(path.join(SCRATCH, "tgt-")), p = (...x) => path.join(r, ...x);
  for (const d of ["home/enclave-prod", "units", "mock", "stage"]) fs.mkdirSync(p(d), { recursive: true, mode: 0o755 });
  const root = p("home/enclave-prod/host-relay-eu");
  const t = { r, p, root, units: p("units"), mock: p("mock"), stage: p("stage"), dir: path.join(root, "state/lease-relay"), mig: path.join(root, "migration"),
    unit: p("units/enclave-host-relay-eu.service"), lanUnit: p("units/enclave-host-relay-eu-lan.service"),
    touch: (n) => fs.writeFileSync(p("mock", n), ""), clear: (n) => fs.rmSync(p("mock", n), { force: true }), has: (n) => fs.existsSync(p("mock", n)),
    calls: () => (fs.existsSync(p("mock/calls")) ? fs.readFileSync(p("mock/calls"), "utf8").split("\n").filter(Boolean).filter((l) => !/^--user show|^show/.test(l)).map((l) => l.replace(/^--user /, "").split(" ")[0]) : []) };
  t.state = path.join(t.dir, "relay-send.json"); fs.writeFileSync(p("mock/state-path"), t.state);
  // the reviewed record, and a configuration rendered by the user renderer from a SYNTHETIC relay.env for this release
  fs.copyFileSync(path.join(WS, "config/lease-gas-deployment.json"), path.join(t.stage, "lease-gas-deployment.json"));
  return t;
}
let renderedRelease = null;
function releaseDir() {   // the archive extracted once (the renderer validates against the release's own role copy)
  if (renderedRelease) return renderedRelease;
  const d = fs.mkdtempSync(path.join(SCRATCH, "rel-"));
  assert.equal(spawnSync("tar", ["-xf", TAR, "-C", d]).status, 0);
  return (renderedRelease = path.join(d, REL_ID));
}
const ENV = ["LEASE_RELAY_RECORD=/etc/enclave-lease-relay/deployment.json", "LEASE_RELAY_DIGEST=sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089",
  "LEASE_RELAY_RPCS=https://rpc-a.example,https://rpc-b.example,https://rpc-c.example", "LEASE_RELAY_QUORUM=2", "LEASE_RELAY_MAX_FLOAT_ETH=0.002", "LEASE_RELAY_MIN_FLOAT_ETH=0.0002", ""].join("\n");
function render(t, { edit } = {}) {
  const envFile = path.join(t.r, "relay.env"); fs.writeFileSync(envFile, ENV);
  const out = path.join(t.stage, "host-relay.json"); fs.rmSync(out, { force: true });
  const r = spawnSync(process.execPath, [path.join(USER, "user-render-config.mjs"), envFile, releaseDir(), out, "--target-root", t.root], { encoding: "utf8", env: { PATH: process.env.PATH, RENDER_TEST_ENV_SHA256: shaB(Buffer.from(ENV)) } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  if (edit) { const c = JSON.parse(fs.readFileSync(out, "utf8")); edit(c); fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 }); }
  return out;
}
const PATHS = `${path.join(HERE, "mockbin")}:${process.env.PATH}`;
const gateStub = (t, code) => { const f = path.join(t.r, `gate-${code}.mjs`); fs.writeFileSync(f, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(t.r, "gate-saw.json"))}, JSON.stringify(process.env)); process.exit(${code});`); return f; };
function envFor(t, s, extra = {}) {
  return { PATH: PATHS, HOME: t.r, MOCK_DIR: t.mock, TEST_TARGET_ROOT: t.root, TEST_UNIT_DIR: t.units, TEST_NODE: process.execPath, ...(s ? { MOCK_ROOT_eu_central: s.r, SRC_FSROOT: s.r } : {}), ...extra };
}
function run(dir, script, args, env) {
  const r = spawnSync("bash", [path.join(dir, script), ...args], { encoding: "utf8", timeout: 170_000, env });
  const out = r.stdout + r.stderr;
  assert.ok(!out.includes(CANARY), `${script}: the key's content never appears in any output`);
  return { code: r.status, out };
}
const onTarget = (t, script, args = [], extra = {}, s = null) => run(USER, script, args, envFor(t, s, extra));
const onSource = (s, script, ...args) => run(SRCS, script, args, { PATH: PATHS, HOME: s.r, FSROOT: s.r });
const stage = (t, mode = "--stage") => onTarget(t, "user-stage.sh", [mode, TAR, TAR_SHA, t.stage]);
const done = (...xs) => { for (const x of xs) if (x) fs.rmSync(x.r, { recursive: true, force: true }); };
const mode = (f) => (fs.statSync(f).mode & 0o777).toString(8);
/** a staged target and a stopped source with the moved files transferred */
function moved({ state = PENDING } = {}) {
  const s = source({ state }), t = target(); render(t);
  assert.equal(onSource(s, "eu-source-stop.sh", "--stop").code, 0);
  assert.equal(stage(t).code, 0);
  const r = onTarget(t, "user-transfer.sh", ["eu-central"], {}, s); assert.equal(r.code, 0, r.out);
  return { s, t };
}

test("the source side is the TESTED root scripts byte for byte; the transfer core keeps the established discipline", () => {
  for (const f of ["eu-source-stop.sh", "eu-source-restore.sh", "eu-source-common.sh"]) assert.equal(sha(path.join(SRCS, f)), sha(path.join(TESTED, f)), f);
  const lib = fs.readFileSync(path.join(USER, "user-transfer-lib.sh"), "utf8");
  for (const re of [/\.incoming-\$name-\$\(_rand\)/, /ln "\$tmp" "\$final"/, /MISMATCH/, /never overwritten/]) assert.match(lib, re);
  const unit = fs.readFileSync(path.join(WS, "files/enclave-host-relay-eu.service.in"), "utf8");
  assert.doesNotMatch(unit, /lease-relay-host\.mjs init/, "the user unit can never generate a key");
  for (const re of [/^MemoryMax=512M$/m, /^TasksMax=64$/m, /^Restart=on-failure$/m, /^StartLimitBurst=5$/m, /^ExecStartPre=.*verify-release\.mjs$/m, /^ExecStartPre=.* check /m]) assert.match(unit, re);
});

test("stage --check is read-only and refuses: an existing target, a wrong archive pin, a foreign configuration, an existing unit, a taken port", T, () => {
  const t = target();
  try {
    render(t);
    let r = stage(t, "--check"); assert.equal(r.code, 0, r.out); assert.match(r.out, new RegExp(`CHECK OK: release ${REL_ID}`));
    assert.ok(!fs.existsSync(t.root), "--check wrote nothing");
    r = onTarget(t, "user-stage.sh", ["--check", TAR, "00".repeat(32), t.stage]); assert.equal(r.code, 2); assert.match(r.out, /not the pinned/);
    for (const [why, edit, re] of [["policy off", (c) => { c.platformHostPolicy = "off"; delete c.platformHostPolicyCarriers; }, /platformHostPolicy must be production/],
      ["another state root", (c) => { c.stateRoot = "/var/lib/other"; }, /stateRoot must be/], ["another package", (c) => { c.relay.package = "sha256:" + "ab".repeat(32); }, /relay\.package must be/],
      ["a public bind", (c) => { c.relay.bind = "0.0.0.0"; }, /relay\.bind must be 127\.0\.0\.1/], ["an advertised endpoint", (c) => { c.host.publicEndpoints = ["https://9.9.9.9:8549/"]; }, /publicEndpoints must be empty/],
      ["a key-like field", (c) => { c.relayKey = "x"; }, /unknown field "relayKey"/]]) {
      render(t, { edit }); r = stage(t, "--check"); assert.equal(r.code, 2, why); assert.match(r.out, re, why);
    }
    render(t);
    fs.writeFileSync(t.unit, "[Service]\n"); r = stage(t, "--check"); assert.equal(r.code, 2); assert.match(r.out, /enclave-host-relay-eu\.service exists/); fs.rmSync(t.unit);
    t.touch("port-taken"); r = stage(t, "--check"); assert.equal(r.code, 2); assert.match(r.out, /listens on :8549/); t.clear("port-taken");
    fs.mkdirSync(t.root); r = stage(t, "--check"); assert.equal(r.code, 2); assert.match(r.out, /exists \(create-only/); fs.rmdirSync(t.root);
    fs.chmodSync(t.p("home/enclave-prod"), 0o777); r = stage(t, "--check"); assert.equal(r.code, 2); assert.match(r.out, /not group\/other writable/); fs.chmodSync(t.p("home/enclave-prod"), 0o755);
  } finally { done(t); }
});

test("stage: the release verified and installed owner-only; configuration and record 0600; state EMPTY 0700; the unit only rendered, NOT installed", T, () => {
  const t = target();
  try {
    render(t);
    const r = stage(t); assert.equal(r.code, 0, r.out); assert.match(r.out, /STAGED: release .* unit NOT installed/);
    assert.ok(!fs.existsSync(t.unit) && !fs.existsSync(t.lanUnit), "nothing can start the role");
    assert.deepEqual(fs.readdirSync(t.dir), []);
    for (const d of [t.root, t.dir, t.mig, path.join(t.root, "etc"), path.join(t.root, "releases", REL_ID)]) assert.equal(mode(d), "700", d);
    for (const f of ["etc/host-relay.json", "etc/lease-gas-deployment.json", `releases/${REL_ID}/RELEASE.json`]) assert.equal(mode(path.join(t.root, f)), "600", f);
    const v = spawnSync(process.execPath, [path.join(t.root, "releases", REL_ID, "verify-release.mjs")], { encoding: "utf8" });
    assert.equal(v.status, 0, v.stdout); assert.match(v.stdout, /verified/);
    const unit = fs.readFileSync(path.join(t.mig, "enclave-host-relay-eu.service.staged"), "utf8");
    assert.ok(unit.includes(`${t.root}/releases/${REL_ID}/app/network/host-services/lease-relay-host.mjs run ${t.root}/etc/host-relay.json`)); assert.doesNotMatch(unit, /@[A-Z]+@/);
    assert.match(fs.readFileSync(path.join(t.mig, "staging-receipt.json"), "utf8"), /"unitInstalled":false/);
    assert.equal(stage(t).code, 2, "create-only: a second stage refuses");
    // an incomplete stage never starts: without its receipt, activation refuses
    fs.renameSync(path.join(t.mig, "staging-receipt.json"), path.join(t.mig, "receipt.aside"));
    const a = onTarget(t, "user-activate.sh", ["--check"]); assert.equal(a.code, 2); assert.match(a.out, /no complete staging/);
    fs.renameSync(path.join(t.mig, "receipt.aside"), path.join(t.mig, "staging-receipt.json"));
    const u = onTarget(t, "user-stage.sh", ["--unstage"]); assert.equal(u.code, 0, u.out);
    assert.ok(!fs.existsSync(t.root) && fs.readdirSync(t.p("home/enclave-prod")).some((n) => n.startsWith("host-relay-eu.unstaged-")), "moved aside, never deleted");
  } finally { done(t); }
});

test("transfer: refusals change nothing; then the source marker FIRST, the journal, then the key (0600, this user's); a second run refuses; the source cannot abort", T, () => {
  const s = source(), t = target();
  try {
    render(t);
    let r = onTarget(t, "user-transfer.sh", ["eu-central"], {}, s); assert.equal(r.code, 2); assert.match(r.out, /no stop receipt/);
    assert.equal(onSource(s, "eu-source-stop.sh", "--stop").code, 0);
    r = onTarget(t, "user-transfer.sh", ["eu-central"], {}, s); assert.equal(r.code, 2); assert.match(r.out, /not staged/);
    assert.equal(stage(t).code, 0);
    fs.writeFileSync(path.join(t.dir, "relay.key"), "other\n", { mode: 0o600 });
    r = onTarget(t, "user-transfer.sh", ["eu-central"], {}, s); assert.equal(r.code, 2); assert.match(r.out, /not an empty 0700 directory/); fs.rmSync(path.join(t.dir, "relay.key"));
    assert.ok(!fs.existsSync(path.join(s.mig, "transfer-begun")), "no marker: nothing began");
    r = onTarget(t, "user-transfer.sh", ["eu-central"], {}, s); assert.equal(r.code, 0, r.out);
    assert.match(r.out, /relay-send\.json: intact[\s\S]*relay\.key: intact/, "journal first, then key");
    assert.ok(fs.existsSync(path.join(s.mig, "transfer-begun")) && !fs.existsSync(path.join(s.mig, "transfer-key-not-delivered")));
    assert.equal(sha(path.join(t.dir, "relay.key")), sha(s.key)); assert.equal(sha(t.state), sha(s.state));
    for (const f of ["relay.key", "relay-send.json"]) { assert.equal(mode(path.join(t.dir, f)), "600"); assert.equal(fs.statSync(path.join(t.dir, f)).uid, process.getuid()); }
    assert.deepEqual(fs.readdirSync(t.dir).sort(), ["relay-send.json", "relay.key"]);
    assert.ok(fs.existsSync(s.key) && fs.existsSync(s.state), "the source keeps its protected originals");
    r = onTarget(t, "user-transfer.sh", ["eu-central"], {}, s); assert.equal(r.code, 2); assert.match(r.out, /already began/);
    const a = onSource(s, "eu-source-restore.sh", "--abort-before-transfer"); assert.equal(a.code, 2); assert.match(a.out, /transfer to the target began/);
    assert.ok(!s.active(), "the source stays stopped: its record may be stale");
  } finally { done(s, t); }
});

test("an interrupted transfer: only a verifiably undelivered key is recorded on the source, which then may abort and restart", T, () => {
  for (const failing of ["relay-send.json", "relay.key"]) {
    const s = source(), t = target();
    try {
      render(t); assert.equal(onSource(s, "eu-source-stop.sh", "--stop").code, 0); assert.equal(stage(t).code, 0);
      const r = onTarget(t, "user-transfer.sh", ["eu-central"], { MOCK_SCP_FAIL: failing }, s);
      assert.equal(r.code, 1, r.out); assert.match(r.out, /transfer FAILED/); assert.match(r.out, /did NOT reach this target \(verified\)/);
      assert.ok(!fs.existsSync(path.join(t.dir, "relay.key")) && !fs.readdirSync(t.dir).some((f) => f.startsWith(".incoming")), `${failing}: no key, no partial copy`);
      assert.ok(fs.existsSync(path.join(s.mig, "transfer-key-not-delivered")));
      const a = onSource(s, "eu-source-restore.sh", "--abort-before-transfer"); assert.equal(a.code, 0, a.out); assert.match(a.out, /RESTORED/);
      assert.ok(s.active() && sha(s.unit) === SRC_UNIT_SHA);
    } finally { done(s, t); }
  }
});

test("ownership: a foreign uid or a symlinked state path refuses activation and transfer", T, () => {
  const { s, t } = moved();
  try {
    let r = onTarget(t, "user-activate.sh", ["--check"], { TEST_GATE: gateStub(t, 0), TEST_EXPECTED_UID: String(process.getuid() + 1) });
    assert.equal(r.code, 2); assert.match(r.out, /owned by uid|not this user's/);
    const real = t.dir + ".real"; fs.renameSync(t.dir, real); fs.symlinkSync(real, t.dir);
    r = onTarget(t, "user-activate.sh", ["--check"], { TEST_GATE: gateStub(t, 0) }); assert.equal(r.code, 2); assert.match(r.out, /not this user's 0700 directory/);
    fs.unlinkSync(t.dir); fs.renameSync(real, t.dir);
    fs.chmodSync(path.join(t.dir, "relay.key"), 0o640);
    r = onTarget(t, "user-activate.sh", ["--check"], { TEST_GATE: gateStub(t, 0) }); assert.equal(r.code, 2); assert.match(r.out, /moved key is not a non-empty 0600/);
    fs.chmodSync(path.join(t.dir, "relay.key"), 0o600);
    fs.writeFileSync(path.join(t.dir, "relay.address"), "0x" + "11".repeat(20) + "\n", { mode: 0o600 });
    r = onTarget(t, "user-activate.sh", ["--check"], { TEST_GATE: gateStub(t, 0) }); assert.equal(r.code, 2); assert.match(r.out, /names another address/);
  } finally { done(s, t); }
});

test("activate: the gate must pass; ever-started precedes the start; it must answer as the moved payee; enabled; a second activation refuses", T, () => {
  const { s, t } = moved();
  try {
    let r = onTarget(t, "user-activate.sh", ["--activate"], { TEST_GATE: gateStub(t, 1) }); assert.equal(r.code, 2, r.out); assert.match(r.out, /gate did not pass/);
    assert.ok(!fs.existsSync(t.unit) && !fs.existsSync(path.join(t.mig, "target-ever-started")) && !t.has("ever-enclave-host-relay-eu.service"), "nothing installed or started");
    const saw = JSON.parse(fs.readFileSync(path.join(t.r, "gate-saw.json"), "utf8"));
    assert.deepEqual(Object.keys(saw).filter((k) => k !== "PATH").sort(), ["LEASE_RELAY_DIGEST", "LEASE_RELAY_EXPECTED_PAYEE", "LEASE_RELAY_MAX_FLOAT_ETH", "LEASE_RELAY_QUORUM",
      "LEASE_RELAY_RECORD", "LEASE_RELAY_RPCS", "LEASE_RELAY_SOURCE_ORIGIN", "LEASE_RELAY_STATE"], "an explicit environment, nothing inherited");
    assert.deepEqual([saw.LEASE_RELAY_EXPECTED_PAYEE, saw.LEASE_RELAY_SOURCE_ORIGIN, saw.LEASE_RELAY_STATE], [PAYEE, "https://134.209.248.172", t.state]);
    const keySha = sha(path.join(t.dir, "relay.key"));
    r = onTarget(t, "user-activate.sh", ["--activate"], { TEST_GATE: gateStub(t, 0) }); assert.equal(r.code, 0, r.out); assert.match(r.out, /ACTIVATED: .* as 0xC5D88d2D/);
    assert.ok(t.has("active-enclave-host-relay-eu.service") && t.has("enabled-enclave-host-relay-eu.service"));
    assert.equal(sha(t.unit), sha(path.join(t.mig, "enclave-host-relay-eu.service.staged")));
    assert.deepEqual(t.calls(), ["daemon-reload", "start", "enable"], "started first, enabled only after it answered as the payee");
    assert.ok(fs.statSync(path.join(t.mig, "target-ever-started")).mtimeMs <= fs.statSync(t.p("mock/ever-enclave-host-relay-eu.service")).mtimeMs, "the marker precedes the start");
    assert.equal(sha(path.join(t.dir, "relay.key")), keySha, "the moved key is never changed");
    assert.equal(fs.readFileSync(path.join(t.dir, "relay.address"), "utf8"), PAYEE + "\n");
    r = onTarget(t, "user-activate.sh", ["--check"], { TEST_GATE: gateStub(t, 0) }); assert.equal(r.code, 2); assert.match(r.out, /already started here once/);
    assert.match(r.out, /is active/); assert.match(r.out, /listens on :8549/);
  } finally { done(s, t); }
});

test("activate fails CLOSED: another payee or reserve -> stopped, moved aside, masked (exit 4); no answer -> stopped, disabled (exit 1); moved files untouched", T, () => {
  for (const [why, setup, code, re] of [
    ["another payee", (t) => fs.writeFileSync(t.p("mock/info"), JSON.stringify({ chainId: 8453, reserve: "0x12A3f873041Dec436DaA0085B766a399A6fA3639", executor: "0x8900BACA2167873BA2F8a8bAE8b4876E6396d343", payee: "0x" + "11".repeat(20) })), 4, /REFUSED: the role answered as '0x1111/],
    ["another reserve", (t) => fs.writeFileSync(t.p("mock/info"), JSON.stringify({ chainId: 8453, reserve: "0x" + "22".repeat(20), executor: "0x8900BACA2167873BA2F8a8bAE8b4876E6396d343", payee: PAYEE })), 4, /REFUSED/],
    ["no answer", (t) => t.touch("silent"), 1, /did not answer .* within 3 s/]]) {
    const { s, t } = moved();
    try {
      setup(t); const keySha = sha(path.join(t.dir, "relay.key")), stateSha = sha(t.state);
      const r = onTarget(t, "user-activate.sh", ["--activate"], { TEST_GATE: gateStub(t, 0), ACTIVATE_ANSWER_WAIT_S: "3" });
      assert.equal(r.code, code, `${why}: ${r.out}`); assert.match(r.out, re, why);
      assert.ok(!t.has("active-enclave-host-relay-eu.service") && !t.has("enabled-enclave-host-relay-eu.service"), `${why}: stopped and not enabled`);
      if (code === 4) { assert.equal(fs.readlinkSync(t.unit), "/dev/null", `${why}: masked`); assert.ok(fs.existsSync(path.join(t.mig, "unit.refused"))); }
      assert.deepEqual([sha(path.join(t.dir, "relay.key")), sha(t.state)], [keySha, stateSha], `${why}: the moved files are untouched`);
    } finally { done(s, t); }
  }
});

test("full rollback after the role ran: out of service, journal back, the source resumes from the RETURNED journal; never from its stale one", T, () => {
  const { s, t } = moved();
  const g = fs.mkdtempSync(path.join(SCRATCH, "srcgate-"));
  try {
    fs.writeFileSync(t.p("mock/start-writes-state"), LATER);     // the role relayed: its journal moved past the source's
    assert.equal(onTarget(t, "user-activate.sh", ["--activate"], { TEST_GATE: gateStub(t, 0) }).code, 0);
    assert.equal(fs.readFileSync(t.state, "utf8"), LATER);
    let r = onTarget(t, "user-journal-back.sh", ["eu-central"], {}, s); assert.equal(r.code, 2); assert.match(r.out, /not verifiably out of service/);
    r = onTarget(t, "user-out-of-service.sh"); assert.equal(r.code, 0, r.out); assert.match(r.out, /TARGET OUT OF SERVICE/);
    assert.equal(fs.readlinkSync(t.unit), "/dev/null"); assert.ok(!t.has("active-enclave-host-relay-eu.service"));
    assert.equal(JSON.parse(fs.readFileSync(path.join(t.mig, "out-of-service-receipt.json"), "utf8")).stateSha256, sha(t.state));
    assert.equal(onTarget(t, "user-out-of-service.sh").code, 0, "idempotent");
    assert.equal(onSource(s, "eu-source-restore.sh", "--abort-before-transfer").code, 2, "the stale source record is refused");
    const sg = path.join(g, "gate.mjs"); fs.writeFileSync(sg, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(g, "saw.json"))}, JSON.stringify(process.env)); process.exit(0);`);
    r = onSource(s, "eu-source-restore.sh", "--after-target-start", "--target-out-of-service", sg); assert.equal(r.code, 2); assert.match(r.out, /from-target is absent/);
    r = onTarget(t, "user-journal-back.sh", ["eu-central"], {}, s); assert.equal(r.code, 0, r.out); assert.match(r.out, /relay-send\.json\.from-target: intact/);
    assert.equal(onTarget(t, "user-journal-back.sh", ["eu-central"], {}, s).code, 2, "never overwritten on the source");
    r = onSource(s, "eu-source-restore.sh", "--after-target-start", "--target-out-of-service", sg); assert.equal(r.code, 0, r.out);
    assert.equal(fs.readFileSync(s.state, "utf8"), LATER, "the source resumes from the target's journal");
    assert.equal(fs.readFileSync(path.join(s.mig, "relay-send.json.before-restore"), "utf8"), PENDING, "its stale record kept aside");
    assert.ok(s.active() && sha(s.unit) === SRC_UNIT_SHA);
    assert.equal(JSON.parse(fs.readFileSync(path.join(g, "saw.json"), "utf8")).LEASE_RELAY_STATE, s.state + ".from-target");
    assert.equal(onTarget(t, "user-activate.sh", ["--check"], { TEST_GATE: gateStub(t, 0) }).code, 2, "the target cannot start again in this run");
  } finally { done(s, t); fs.rmSync(g, { recursive: true, force: true }); }
});

test("forwarder step: refused unless the relay is active as the moved payee and warden holds 192.168.8.249; it must be the ONLY non-loopback :8549 listener", T, () => {
  const { s, t } = moved();
  try {
    let r = onTarget(t, "user-forwarder.sh", ["--check"]); assert.equal(r.code, 2); assert.match(r.out, /relay is not active/);
    assert.equal(onTarget(t, "user-activate.sh", ["--activate"], { TEST_GATE: gateStub(t, 0) }).code, 0);
    fs.writeFileSync(t.p("mock/ip-addrs"), "127.0.0.1\n192.168.8.250\n");
    r = onTarget(t, "user-forwarder.sh", ["--check"]); assert.equal(r.code, 2); assert.match(r.out, /does not hold 192\.168\.8\.249/); fs.rmSync(t.p("mock/ip-addrs"));
    t.touch("wildcard-listener"); r = onTarget(t, "user-forwarder.sh", ["--check"]); assert.equal(r.code, 2); assert.match(r.out, /already listens on a non-loopback/); t.clear("wildcard-listener");
    r = onTarget(t, "user-forwarder.sh", ["--check"]); assert.equal(r.code, 0, r.out);
    r = onTarget(t, "user-forwarder.sh", ["--activate"]); assert.equal(r.code, 0, r.out); assert.match(r.out, /FORWARDER ACTIVE: 192\.168\.8\.249:8549 -> 127\.0\.0\.1:8549/);
    assert.ok(t.has("active-enclave-host-relay-eu-lan.service"));
    r = onTarget(t, "user-forwarder.sh", ["--remove"]); assert.equal(r.code, 0, r.out); assert.ok(!t.has("active-enclave-host-relay-eu-lan.service") && !fs.existsSync(t.lanUnit));
    // a listener anywhere else is refused after the start
    r = onTarget(t, "user-forwarder.sh", ["--activate"], { MOCK_LAN_LISTEN: "0.0.0.0" }); assert.equal(r.code, 1); assert.match(r.out, /not exactly 192\.168\.8\.249:8549/);
    assert.ok(!t.has("active-enclave-host-relay-eu-lan.service"));
  } finally { done(s, t); }
});
