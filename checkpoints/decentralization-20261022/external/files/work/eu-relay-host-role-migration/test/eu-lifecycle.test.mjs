// The EXACT eu-central source, transfer and warden scripts against two isolated mock hosts (FSROOT each) with mock
// systemctl/curl/pgrep/ss (test/mockbin) and a mock ssh/scp (test/mockssh) that runs each "remote" command here, as that
// host. The source fixture is eu-central as installed from the reviewed kit (unit 4b3e5ac7, relay.env 7c05d44a, a 0600 key,
// the send record under /var/lib/private); warden gets main's role supervisor (a symlink to this repository's checkout) and
// the staged inputs from ../package and ../config. The migration gate is a stub that records its environment and exits with
// a chosen code (its real logic is main's, tested there). Nothing real is touched; the fixture key never appears in output.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)), WS = path.resolve(HERE, ".."), ROOT = path.join(WS, "root");
const MAIN = path.resolve(WS, "../enclave"), KIT = path.resolve(WS, "../lease-relay-activation/final-94f4ebdf");
const sha = (f) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const CANARY = "c0ffee".repeat(10) + "abcd";
const PAYEE = "0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a";
const PENDING = JSON.stringify({ nonce: 7, raw: "0x02f86b82210507", hash: "0x" + "ab".repeat(32) });
const LATER = JSON.stringify({ nonce: 9, raw: "0x02f86b82210509", hash: "0x" + "cd".repeat(32) });
const SRC_UNIT_SHA = "4b3e5ac7b384911aec0995bc42d255c1b503197935aa24f5945984fd4e09b6ba";
const ROLE_UNIT_SHA = "d279eb490d879d23c01190a3682e262205234c3ab14158721be6a85b8395f4c6";
const MIB = { timeout: 120_000 };

function host(name) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), `eu-${name}-`));
  fs.mkdirSync(path.join(r, "mock"), { recursive: true });
  return { r, p: (...x) => path.join(r, ...x), touch: (n) => fs.writeFileSync(path.join(r, "mock", n), ""), clear: (n) => fs.rmSync(path.join(r, "mock", n), { force: true }),
    has: (n) => fs.existsSync(path.join(r, "mock", n)), calls: () => fs.readFileSync(path.join(r, "mock/calls"), "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[0]).filter((v) => v !== "show") };
}
function source({ state = PENDING } = {}) {
  const h = host("source");
  for (const d of ["etc/systemd/system", "etc/enclave-lease-relay", "var/lib/enclave-lease-relay", "var/lib/private/enclave-lease-relay-state"]) fs.mkdirSync(h.p(d), { recursive: true });
  fs.copyFileSync(path.join(KIT, "enclave-lease-relay-credential-copy.service"), h.p("etc/systemd/system/enclave-lease-relay.service"));
  fs.copyFileSync(path.join(KIT, "relay.env"), h.p("etc/enclave-lease-relay/relay.env"));   // the reviewed kit's bytes, opaque here
  fs.writeFileSync(h.p("var/lib/enclave-lease-relay/relay.key"), "0x" + CANARY + "\n", { mode: 0o600 });
  h.state = h.p("var/lib/private/enclave-lease-relay-state/relay-send.json"); fs.writeFileSync(h.state, state, { mode: 0o600 });
  fs.writeFileSync(h.p("mock/state-path"), h.state);
  h.key = h.p("var/lib/enclave-lease-relay/relay.key"); h.mig = h.p("var/lib/enclave-lease-relay-migration"); h.unit = h.p("etc/systemd/system/enclave-lease-relay.service");
  h.touch("active"); h.touch("enabled");
  return h;
}
function warden() {
  const h = host("warden");
  fs.mkdirSync(h.p("opt"), { recursive: true }); fs.symlinkSync(MAIN, h.p("opt/enclave"));
  fs.mkdirSync(h.p("etc/systemd/system"), { recursive: true }); fs.mkdirSync(h.p("var/lib"), { recursive: true });   // as on any host
  h.dir = h.p("var/lib/private/enclave-host-relay/lease-relay"); h.mig = h.p("var/lib/enclave-host-relay-migration");
  h.unit = h.p("etc/systemd/system/enclave-host-relay.service"); h.state = path.join(h.dir, "relay-send.json");
  fs.writeFileSync(h.p("mock/state-path"), h.state);
  // the stage directory root copies over: the package and gate built from main, the reviewed record and unit, a config
  h.stage = h.p("stage"); fs.mkdirSync(h.stage);
  for (const f of ["lease-relay.mjs", "lease-relay.package.json"]) fs.copyFileSync(path.join(WS, "package", f), path.join(h.stage, f));
  fs.copyFileSync(path.join(WS, "package/gate/lease-relay-migration-check.mjs"), path.join(h.stage, "lease-relay-migration-check.mjs"));
  fs.copyFileSync(path.join(WS, "config/lease-gas-deployment.json"), path.join(h.stage, "lease-gas-deployment.json"));
  fs.copyFileSync(path.join(WS, "config/enclave-host-relay.service"), path.join(h.stage, "enclave-host-relay.service"));
  fs.writeFileSync(path.join(h.stage, "host-relay.json"), JSON.stringify(config(), null, 2) + "\n");
  return h;
}
/** a rendered configuration with SYNTHETIC relay values (production renders them from eu-central's reviewed relay.env) */
function config(over = {}) {
  const t = JSON.parse(fs.readFileSync(path.join(WS, "config/host-relay.template.json"), "utf8"));
  return { ...t, ...over, relay: { ...t.relay, rpc: ["https://rpc-a.example", "https://rpc-b.example", "https://rpc-c.example"], quorum: 2, maxFloatEth: "0.002", minFloatEth: "0.0002", ...(over.relay || {}) } };
}
const env = (s, w, extra = {}) => ({ PATH: `${path.join(HERE, "mockbin")}:${path.join(HERE, "mockssh")}:${process.env.PATH}`, HOME: os.tmpdir(), NODE: process.execPath,
  MOCK_ROOT_eu_central: s?.r, MOCK_UNIT_eu_central: "enclave-lease-relay.service", MOCK_ROOT_warden: w?.r, MOCK_UNIT_warden: "enclave-host-relay.service", ...extra });
function run(script, args, e) {
  const r = spawnSync("bash", [path.join(ROOT, script), ...args], { encoding: "utf8", timeout: 120_000, env: e });
  const out = r.stdout + r.stderr;
  assert.ok(!out.includes(CANARY), `${script}: the key's content never appears in any output`);
  return { code: r.status, out };
}
const onSource = (s, script, ...args) => run(script, args, env(s, null, { FSROOT: s.r, MOCK_UNIT: "enclave-lease-relay.service" }));
const onWarden = (w, script, ...args) => run(script, args, env(null, w, { FSROOT: w.r, MOCK_UNIT: "enclave-host-relay.service" }));
const fromWorkstation = (s, w, script, ...args) => run(script, args, env(s, w, { SRC_FSROOT: s.r, DST_FSROOT: w.r }));
const gate = (dir, code) => { const f = path.join(dir, `gate-${code}.mjs`); fs.writeFileSync(f, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(dir, "gate-saw.json"))}, JSON.stringify(process.env)); process.exit(${code});`); return f; };
const stubWardenGate = (w, code) => {   // replace the staged (real) gate by a stub AFTER staging; the CAS then needs its sha
  fs.writeFileSync(path.join(w.mig, "gate/lease-relay-migration-check.mjs"), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(w.p("mock/gate-saw.json"))}, JSON.stringify(process.env)); process.exit(${code});`);
};
const done = (...hs) => { for (const h of hs) if (h) fs.rmSync(h.r, { recursive: true, force: true }); };
/** the warden scripts pin the real gate's sha256; the stub gate gets its own via this TEST-ONLY copy of warden-common.sh */
function withStubPins(w) {
  const dir = w.p("scripts"); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(ROOT)) fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  return (code) => { stubWardenGate(w, code); const s = sha(path.join(w.mig, "gate/lease-relay-migration-check.mjs"));
    const c = path.join(dir, "warden-common.sh"); fs.writeFileSync(c, fs.readFileSync(c, "utf8").replace(/^GATE_SHA=[0-9a-f]{64}/m, `GATE_SHA=${s}`)); return dir; };
}
const runIn = (dir, w, script, ...args) => { const r = spawnSync("bash", [path.join(dir, script), ...args], { encoding: "utf8", timeout: 120_000, env: env(null, w, { FSROOT: w.r, MOCK_UNIT: "enclave-host-relay.service" }) });
  const out = r.stdout + r.stderr; assert.ok(!out.includes(CANARY)); return { code: r.status, out }; };

test("the reused artifacts are the reviewed bytes: source unit and relay.env, role unit, record, transfer-lib, package and gate pins", () => {
  assert.equal(sha(path.join(KIT, "enclave-lease-relay-credential-copy.service")), SRC_UNIT_SHA);
  assert.equal(sha(path.join(KIT, "relay.env")), "7c05d44ad8b0ad2777d73af8cb7895c6dbb8abd040ce8e5cb36e8d466b0d6769");
  assert.equal(sha(path.join(WS, "config/enclave-host-relay.service")), ROLE_UNIT_SHA); assert.equal(sha(path.join(MAIN, "relay/systemd/enclave-host-relay.service")), ROLE_UNIT_SHA);
  assert.equal(sha(path.join(WS, "config/lease-gas-deployment.json")), "1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089");
  assert.equal(sha(path.join(ROOT, "transfer-lib.sh")), sha(path.resolve(WS, "../windows-local-relay-migration/root/transfer-lib.sh")), "the established opaque copy, unchanged");
  const common = fs.readFileSync(path.join(ROOT, "warden-common.sh"), "utf8"), pinOf = (n) => new RegExp(`^${n}=(\\S+)`, "m").exec(common)[1];
  assert.equal(pinOf("PKG_PIN"), "sha256:" + sha(path.join(WS, "package/lease-relay.package.json")));
  assert.equal(pinOf("BUNDLE_SHA"), sha(path.join(WS, "package/lease-relay.mjs")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(WS, "package/lease-relay.package.json"), "utf8")).bundleSha256, pinOf("BUNDLE_SHA"));
  assert.equal(pinOf("GATE_SHA"), sha(path.join(WS, "package/gate/lease-relay-migration-check.mjs")));
  assert.equal(pinOf("HOST_MJS_SHA"), sha(path.join(MAIN, "network/host-services/lease-relay-host.mjs")));
  assert.equal(pinOf("UNIT_SHA"), ROLE_UNIT_SHA);
  assert.equal(JSON.parse(fs.readFileSync(path.join(WS, "config/host-relay.template.json"), "utf8")).relay.package, pinOf("PKG_PIN"));
});

test("eu-source-stop.sh: the established stop for eu-central (payee 0xC5D8..., front 134.209.248.172): masked, receipt, key and record untouched", MIB, () => {
  const s = source();
  try {
    const before = [sha(s.key), sha(s.state)];
    const c = onSource(s, "eu-source-stop.sh", "--check"); assert.equal(c.code, 0, c.out); assert.match(c.out, /CHECK OK/); assert.match(c.out, /UNRESOLVED nonce 7/);
    const r = onSource(s, "eu-source-stop.sh", "--stop"); assert.equal(r.code, 0, r.out); assert.match(r.out, /SOURCE STOPPED \(masked/);
    assert.ok(!s.has("active") && fs.readlinkSync(s.unit) === "/dev/null");
    assert.deepEqual([sha(s.key), sha(s.state)], before);
    assert.deepEqual(s.calls(), ["stop", "disable", "daemon-reload", "mask", "daemon-reload"]);
    const receipt = JSON.parse(fs.readFileSync(path.join(s.mig, "stop-receipt.json"), "utf8"));
    assert.equal(receipt.stateSha256, before[1]); assert.equal(receipt.unitSha256, SRC_UNIT_SHA);
  } finally { done(s); }
  const t = source(); try { t.touch("front-still-serves"); const r = onSource(t, "eu-source-stop.sh", "--stop"); assert.equal(r.code, 1); assert.match(r.out, /answers \/v1\/info as 0xC5D88d2D/); } finally { done(t); }
});

test("transfer refuses without a stop receipt, without staging, into a non-empty directory, or with the role installed; nothing is copied or marked", MIB, () => {
  const s = source(), w = warden();
  try {
    let r = fromWorkstation(s, w, "transfer-to-warden.sh", "eu-central", "warden"); assert.equal(r.code, 2); assert.match(r.out, /no stop receipt/);
    assert.equal(onSource(s, "eu-source-stop.sh", "--stop").code, 0);
    r = fromWorkstation(s, w, "transfer-to-warden.sh", "eu-central", "warden"); assert.equal(r.code, 2); assert.match(r.out, /no staging receipt/);
    assert.equal(onWarden(w, "warden-stage.sh", "--stage", w.stage).code, 0);
    fs.writeFileSync(path.join(w.dir, "relay.key"), "other\n", { mode: 0o600 });
    r = fromWorkstation(s, w, "transfer-to-warden.sh", "eu-central", "warden"); assert.equal(r.code, 2); assert.match(r.out, /absent or not empty/);
    fs.rmSync(path.join(w.dir, "relay.key")); fs.copyFileSync(path.join(w.mig, "unit.staged"), w.unit);
    r = fromWorkstation(s, w, "transfer-to-warden.sh", "eu-central", "warden"); assert.equal(r.code, 2); assert.match(r.out, /installed or has run/);
    assert.ok(!fs.existsSync(path.join(s.mig, "transfer-begun")), "no marker: nothing began");
    assert.equal(fs.readdirSync(w.dir).length, 0);
  } finally { done(s, w); }
});

test("transfer: the source marker comes FIRST, then the journal, then the key (byte-identical, 0600); the source keeps its files; a second run refuses", MIB, () => {
  const s = source(), w = warden();
  try {
    assert.equal(onSource(s, "eu-source-stop.sh", "--stop").code, 0);
    assert.equal(onWarden(w, "warden-stage.sh", "--stage", w.stage).code, 0);
    const r = fromWorkstation(s, w, "transfer-to-warden.sh", "eu-central", "warden");
    assert.equal(r.code, 0, r.out); assert.match(r.out, /relay-send\.json: intact[\s\S]*relay\.key: intact/, "journal first, then key");
    assert.ok(fs.existsSync(path.join(s.mig, "transfer-begun")) && !fs.existsSync(path.join(s.mig, "transfer-key-not-delivered")));
    assert.equal(sha(path.join(w.dir, "relay.key")), sha(s.key)); assert.equal(sha(w.state), sha(s.state));
    for (const f of ["relay.key", "relay-send.json"]) assert.equal(fs.statSync(path.join(w.dir, f)).mode & 0o777, 0o600);
    assert.ok(fs.existsSync(s.key) && fs.existsSync(s.state), "the source copies stay (the protected originals)");
    assert.deepEqual(fs.readdirSync(w.dir).sort(), ["relay-send.json", "relay.key"], "no temporary copies left");
    const again = fromWorkstation(s, w, "transfer-to-warden.sh", "eu-central", "warden"); assert.equal(again.code, 2); assert.match(again.out, /already began/);
    // the key may now run on warden: the source refuses to restart from its own record
    const a = onSource(s, "eu-source-restore.sh", "--abort-before-transfer"); assert.equal(a.code, 2); assert.match(a.out, /transfer to the target began/);
    assert.ok(!s.has("active") && fs.readlinkSync(s.unit) === "/dev/null", "still stopped and masked");
  } finally { done(s, w); }
});

test("an interrupted transfer: the key verifiably not delivered is recorded on the source, and only then may it abort and restart", MIB, () => {
  for (const failing of ["relay-send.json", "relay.key"]) {
    const s = source(), w = warden();
    try {
      assert.equal(onSource(s, "eu-source-stop.sh", "--stop").code, 0);
      assert.equal(onWarden(w, "warden-stage.sh", "--stage", w.stage).code, 0);
      const r = run("transfer-to-warden.sh", ["eu-central", "warden"], env(s, w, { SRC_FSROOT: s.r, DST_FSROOT: w.r, MOCK_SCP_FAIL: failing }));
      assert.equal(r.code, 1, r.out); assert.match(r.out, /transfer FAILED/); assert.match(r.out, /did NOT reach warden \(verified\)/);
      assert.ok(!fs.existsSync(path.join(w.dir, "relay.key")), `${failing}: no key on warden`);
      assert.ok(!fs.readdirSync(w.dir).some((f) => f.startsWith(".incoming")), "the partial temporary copy was removed");
      assert.ok(fs.existsSync(path.join(s.mig, "transfer-key-not-delivered")));
      const a = onSource(s, "eu-source-restore.sh", "--abort-before-transfer"); assert.equal(a.code, 0, a.out); assert.match(a.out, /RESTORED/);
      assert.ok(s.has("active") && sha(s.unit) === SRC_UNIT_SHA);
    } finally { done(s, w); }
  }
});

test("warden-stage.sh: --check is read-only and refuses a missing checkout, a wrong pin, policy off or no carriers; --stage installs everything EXCEPT the unit", MIB, () => {
  const w = warden();
  try {
    fs.unlinkSync(w.p("opt/enclave"));
    let r = onWarden(w, "warden-stage.sh", "--check", w.stage); assert.equal(r.code, 2); assert.match(r.out, /no reviewed checkout/);
    fs.symlinkSync(MAIN, w.p("opt/enclave"));
    for (const [why, cfg, re] of [["policy off", config({ platformHostPolicy: "off", platformHostPolicyCarriers: undefined }), /platformHostPolicy off is not a production/],
      ["no carriers", config({ platformHostPolicyCarriers: undefined }), /no platform host policy carriers/],
      ["another package", config({ relay: { package: "sha256:" + "ab".repeat(32) } }), /relay\.package is sha256:abab/],
      ["another state root", config({ stateRoot: "/var/lib/other" }), /stateRoot must be/],
      ["a key-like field", { ...config(), relayKey: "x" }, /unknown field "relayKey"/]]) {
      fs.writeFileSync(path.join(w.stage, "host-relay.json"), JSON.stringify(cfg));
      r = onWarden(w, "warden-stage.sh", "--check", w.stage); assert.equal(r.code, 2, why); assert.match(r.out, re, why);
    }
    fs.writeFileSync(path.join(w.stage, "host-relay.json"), JSON.stringify(config(), null, 2) + "\n");
    fs.appendFileSync(path.join(w.stage, "enclave-host-relay.service"), "#x\n");
    r = onWarden(w, "warden-stage.sh", "--check", w.stage); assert.equal(r.code, 2); assert.match(r.out, /enclave-host-relay\.service is [0-9a-f]{64}, not the reviewed/);
    fs.copyFileSync(path.join(WS, "config/enclave-host-relay.service"), path.join(w.stage, "enclave-host-relay.service"));
    r = onWarden(w, "warden-stage.sh", "--check", w.stage); assert.equal(r.code, 0, r.out); assert.match(r.out, /CHECK OK/);
    assert.ok(!fs.existsSync(w.mig) && !fs.existsSync(w.p("etc/enclave")), "--check wrote nothing");
    r = onWarden(w, "warden-stage.sh", "--stage", w.stage); assert.equal(r.code, 0, r.out); assert.match(r.out, /STAGED/);
    assert.ok(!fs.existsSync(w.unit), "the unit is NOT installed: nothing can start the role or let `init` make a key");
    assert.deepEqual(fs.readdirSync(w.dir), []); assert.equal(fs.statSync(w.dir).mode & 0o777, 0o700);
    assert.equal(sha(path.join(w.mig, "unit.staged")), ROLE_UNIT_SHA);
    const rc = JSON.parse(fs.readFileSync(path.join(w.mig, "staging-receipt.json"), "utf8"));
    assert.equal(rc.unitInstalled, false); assert.equal(rc.configSha256, sha(w.p("etc/enclave/host-relay.json")));
    assert.ok(!w.has("calls") || !w.calls().length, "no systemctl verb but show");
    assert.equal(onWarden(w, "warden-stage.sh", "--stage", w.stage).code, 0, "re-staging the same bytes is accepted");
    r = onWarden(w, "warden-stage.sh", "--unstage"); assert.equal(r.code, 0, r.out);
    assert.ok(!fs.existsSync(w.p("etc/enclave/host-relay.json")) && !fs.existsSync(w.dir) && !fs.existsSync(w.mig));
  } finally { done(w); }
});

test("warden-activate.sh: the gate must pass; the ever-started marker precedes the start; it must answer as the moved payee; then enabled", MIB, () => {
  const s = source(), w = warden();
  try {
    assert.equal(onSource(s, "eu-source-stop.sh", "--stop").code, 0);
    assert.equal(onWarden(w, "warden-stage.sh", "--stage", w.stage).code, 0);
    let r = onWarden(w, "warden-activate.sh", "--check"); assert.equal(r.code, 2); assert.match(r.out, /moved key is not/);
    assert.equal(fromWorkstation(s, w, "transfer-to-warden.sh", "eu-central", "warden").code, 0);
    const pins = withStubPins(w);
    // the real staged gate is pinned: a substituted gate refuses at the CAS
    stubWardenGate(w, 0); r = onWarden(w, "warden-activate.sh", "--check"); assert.equal(r.code, 2); assert.match(r.out, /staged gate is not/);
    let dir = pins(1);
    r = runIn(dir, w, "warden-activate.sh", "--activate"); assert.equal(r.code, 2, r.out); assert.match(r.out, /gate did not pass/);
    assert.ok(!fs.existsSync(w.unit) && !fs.existsSync(path.join(w.mig, "target-ever-started")) && !w.has("ever-started"), "nothing installed or started");
    const saw = JSON.parse(fs.readFileSync(w.p("mock/gate-saw.json"), "utf8"));
    assert.deepEqual(Object.keys(saw).filter((k) => k !== "PATH").sort(), ["LEASE_RELAY_DIGEST", "LEASE_RELAY_EXPECTED_PAYEE", "LEASE_RELAY_MAX_FLOAT_ETH", "LEASE_RELAY_QUORUM",
      "LEASE_RELAY_RECORD", "LEASE_RELAY_RPCS", "LEASE_RELAY_SOURCE_ORIGIN", "LEASE_RELAY_STATE"], "an explicit environment, nothing inherited");
    assert.deepEqual([saw.LEASE_RELAY_EXPECTED_PAYEE, saw.LEASE_RELAY_SOURCE_ORIGIN, saw.LEASE_RELAY_STATE, saw.LEASE_RELAY_RPCS, saw.LEASE_RELAY_QUORUM],
      [PAYEE, "https://134.209.248.172", w.state, "https://rpc-a.example,https://rpc-b.example,https://rpc-c.example", "2"]);
    assert.equal(fs.readFileSync(path.join(w.dir, "relay.address"), "utf8"), PAYEE + "\n", "the label init needs to KEEP the moved key");
    const keySha = sha(path.join(w.dir, "relay.key"));
    dir = pins(0);
    r = runIn(dir, w, "warden-activate.sh", "--activate"); assert.equal(r.code, 0, r.out); assert.match(r.out, /ACTIVATED: .* as 0xC5D88d2D/);
    assert.ok(w.has("active") && w.has("enabled")); assert.equal(sha(w.unit), ROLE_UNIT_SHA);
    assert.deepEqual(w.calls(), ["daemon-reload", "start", "enable"], "started first, enabled only after it answered as the payee");
    const ever = JSON.parse(fs.readFileSync(path.join(w.mig, "target-ever-started"), "utf8"));
    assert.ok(fs.statSync(path.join(w.mig, "target-ever-started")).mtimeMs <= fs.statSync(w.p("mock/ever-started")).mtimeMs, "the marker precedes the start");
    assert.equal(ever.stateShape, "UNRESOLVED nonce 7 hash 0x" + "ab".repeat(32));
    assert.equal(sha(path.join(w.dir, "relay.key")), keySha, "the key is never changed");
    r = runIn(dir, w, "warden-activate.sh", "--check"); assert.equal(r.code, 2); assert.match(r.out, /already started here once/);
  } finally { done(s, w); }
});

test("warden-activate.sh fails CLOSED: another payee -> stopped, unit moved aside, masked, exit 4; no answer -> stopped and disabled, exit 1", MIB, () => {
  for (const [why, setup, code, re] of [
    ["another payee", (w) => fs.writeFileSync(w.p("mock/info"), JSON.stringify({ chainId: 8453, reserve: "0x12A3f873041Dec436DaA0085B766a399A6fA3639", executor: "0x8900BACA2167873BA2F8a8bAE8b4876E6396d343", payee: "0x" + "11".repeat(20) })), 4, /REFUSED: the role answered as '0x1111/],
    ["another reserve", (w) => fs.writeFileSync(w.p("mock/info"), JSON.stringify({ chainId: 8453, reserve: "0x" + "22".repeat(20), executor: "0x8900BACA2167873BA2F8a8bAE8b4876E6396d343", payee: PAYEE })), 4, /REFUSED/],
    ["no answer (start failure or policy refusal)", (w) => w.touch("silent"), 1, /did not answer .* within 3 s/],
  ]) {
    const s = source(), w = warden();
    try {
      assert.equal(onSource(s, "eu-source-stop.sh", "--stop").code, 0); assert.equal(onWarden(w, "warden-stage.sh", "--stage", w.stage).code, 0);
      assert.equal(fromWorkstation(s, w, "transfer-to-warden.sh", "eu-central", "warden").code, 0);
      setup(w); const keySha = sha(path.join(w.dir, "relay.key")), stateSha = sha(w.state);
      const dir = withStubPins(w)(0);
      const r = spawnSync("bash", [path.join(dir, "warden-activate.sh"), "--activate"], { encoding: "utf8", timeout: 120_000,
        env: env(null, w, { FSROOT: w.r, MOCK_UNIT: "enclave-host-relay.service", ACTIVATE_ANSWER_WAIT_S: "3" }) });
      const out = r.stdout + r.stderr; assert.ok(!out.includes(CANARY));
      assert.equal(r.status, code, `${why}: ${out}`); assert.match(out, re, why);
      assert.ok(!w.has("active") && !w.has("enabled"), `${why}: stopped`);
      if (code === 4) { assert.equal(fs.readlinkSync(w.unit), "/dev/null", `${why}: masked`); assert.equal(sha(path.join(w.mig, "unit.refused")), ROLE_UNIT_SHA); }
      else assert.equal(sha(w.unit), ROLE_UNIT_SHA, `${why}: left installed but stopped and disabled, for the operator to inspect`);
      assert.deepEqual([sha(path.join(w.dir, "relay.key")), sha(w.state)], [keySha, stateSha], `${why}: the moved files are untouched`);
    } finally { done(s, w); }
  }
});

test("rollback after the role ran: out of service, journal back, restore from the RETURNED journal (gate passing); never from the stale one", MIB, () => {
  const s = source(), w = warden(), g = fs.mkdtempSync(path.join(os.tmpdir(), "eu-gate-"));
  try {
    assert.equal(onSource(s, "eu-source-stop.sh", "--stop").code, 0); assert.equal(onWarden(w, "warden-stage.sh", "--stage", w.stage).code, 0);
    assert.equal(fromWorkstation(s, w, "transfer-to-warden.sh", "eu-central", "warden").code, 0);
    fs.writeFileSync(w.p("mock/start-writes-state"), LATER);           // the role relays: its journal moves past the source's
    assert.equal(runIn(withStubPins(w)(0), w, "warden-activate.sh", "--activate").code, 0);
    assert.equal(fs.readFileSync(w.state, "utf8"), LATER);
    // the journal cannot go back while the role serves
    let r = fromWorkstation(s, w, "transfer-journal-back.sh", "warden", "eu-central"); assert.equal(r.code, 2); assert.match(r.out, /not verifiably out of service/);
    r = onWarden(w, "warden-out-of-service.sh"); assert.equal(r.code, 0, r.out); assert.match(r.out, /TARGET OUT OF SERVICE/);
    assert.ok(!w.has("active") && fs.readlinkSync(w.unit) === "/dev/null"); assert.equal(sha(path.join(w.mig, "unit.out-of-service")), ROLE_UNIT_SHA);
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.mig, "out-of-service-receipt.json"), "utf8")).stateSha256, sha(w.state));
    assert.equal(onWarden(w, "warden-out-of-service.sh").code, 0, "idempotent");
    // the stale source record is refused for an abort, and for --after-target-start until the journal is back
    assert.equal(onSource(s, "eu-source-restore.sh", "--abort-before-transfer").code, 2);
    r = onSource(s, "eu-source-restore.sh", "--after-target-start", "--target-out-of-service", gate(g, 0)); assert.equal(r.code, 2); assert.match(r.out, /from-target is absent/);
    r = fromWorkstation(s, w, "transfer-journal-back.sh", "warden", "eu-central"); assert.equal(r.code, 0, r.out); assert.match(r.out, /relay-send\.json\.from-target: intact/);
    r = onSource(s, "eu-source-restore.sh", "--after-target-start", "--target-out-of-service", gate(g, 1)); assert.equal(r.code, 2); assert.match(r.out, /gate did not pass/);
    assert.equal(fs.readFileSync(s.state, "utf8"), PENDING, "a failing gate changes nothing");
    r = onSource(s, "eu-source-restore.sh", "--after-target-start", "--target-out-of-service", gate(g, 0)); assert.equal(r.code, 0, r.out);
    assert.equal(fs.readFileSync(s.state, "utf8"), LATER, "the source resumes from warden's journal, never its stale one");
    assert.equal(fs.readFileSync(path.join(s.mig, "relay-send.json.before-restore"), "utf8"), PENDING, "the stale record is kept aside");
    assert.ok(s.has("active") && sha(s.unit) === SRC_UNIT_SHA);
    const saw = JSON.parse(fs.readFileSync(path.join(g, "gate-saw.json"), "utf8"));
    assert.equal(saw.LEASE_RELAY_STATE, s.state + ".from-target"); assert.equal(saw.LEASE_RELAY_EXPECTED_PAYEE, PAYEE);
    // warden cannot be re-activated by the same run (a second move needs a new review)
    assert.equal(runIn(path.join(w.r, "scripts"), w, "warden-activate.sh", "--check").code, 2);
  } finally { done(s, w); fs.rmSync(g, { recursive: true, force: true }); }
});
