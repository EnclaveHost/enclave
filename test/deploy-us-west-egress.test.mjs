// scripts/deploy-us-west-egress.sh against a SYNTHETIC checkout and a SYNTHETIC remote /opt/nan-relay, with stub ssh/scp
// only (no real host, key, token or restart). The stub ssh runs the script's own READ-ONLY probe against the fixture
// directory and records every other command without running it, so a test sees exactly what would have been written.
// The contract (U7 preflight, enclave-99 and enclave-5d): an existing host's shared relay modules are never replaced
// from here; they must be byte-identical to this checkout's, or the run is refused before any write or token pull.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "tok-TEST-0123456789abcdef-not-a-real-token";
const U7 = "\n// U7-shaped fleet: the SNI relay calls this at boot\nexport async function startEligibility() {}\n";

// egress-relay.js's relative imports, transitively: the set the script must derive on its own
function closure(dir) {
  const seen = new Set(), todo = ["egress-relay.js"];
  while (todo.length) {
    const f = todo.shift(), src = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']\.\/([^"']+)["']/g)) if (!seen.has(m[1])) { seen.add(m[1]); todo.push(m[1]); }
  }
  return [...seen];
}
const SHARED = [...closure(path.join(REPO, "relay")), "package.json", "package-lock.json"];
const WORLDS = [];
after(() => { for (const w of WORLDS) fs.rmSync(w, { recursive: true, force: true }); });

const STUB_SSH = `#!/usr/bin/env node
const fs = require("fs"), { spawnSync } = require("child_process");
const a = process.argv.slice(2); let i = 0; while (a[i] === "-o") i += 2;
const host = a[i], cmd = a.slice(i + 1).join(" ");
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: "ssh", host, cmd }) + "\\n");
if (cmd.includes("reached $(hostname)")) { console.log("[us-west-egress] reached stubhost"); process.exit(0); }
if (cmd.includes("EGRESS_RELAY_TOKEN=")) { console.log(process.env.STUB_TOKEN); process.exit(0); }
if (cmd.startsWith("d=/opt/nan-relay;")) {                 // the read-only probe, run for real against the fixture
  const r = spawnSync("sh", ["-c", cmd.split("/opt/nan-relay").join(process.env.STUB_ROOT + "/opt/nan-relay")], { encoding: "utf8" });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status);
}
if (cmd.includes("bash -s")) { fs.appendFileSync(process.env.STUB_STDIN, fs.readFileSync(0)); process.exit(0); }
process.exit(0);
`;
const STUB_SCP = `#!/usr/bin/env node
require("fs").appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: "scp", args: process.argv.slice(2).filter((x, i, a) => x !== "-o" && a[i - 1] !== "-o") }) + "\\n");
`;

/** A synthetic checkout (the script, the relay files, net-guard.mjs as the repo's symlink) and a synthetic host. */
const EXTRA_IMPORT = "\nimport { extra } from \"./extra.mjs\"; void extra;\n", EXTRA = "export const extra = 1;\n";
function world({ checkoutU7 = false, host = "identical", hostU7 = false, drop = null, change = null, others = ["relay.js", "api-relay.js"], extra = null } = {}) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "egress-deploy-")); WORLDS.push(w);
  const co = path.join(w, "checkout"), rel = path.join(co, "relay");
  fs.mkdirSync(path.join(co, "scripts"), { recursive: true }); fs.mkdirSync(path.join(rel, "systemd"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "scripts/deploy-us-west-egress.sh"), path.join(co, "scripts/deploy-us-west-egress.sh"));
  fs.copyFileSync(path.join(REPO, "net-guard.mjs"), path.join(co, "net-guard.mjs"));
  fs.symlinkSync("../net-guard.mjs", path.join(rel, "net-guard.mjs"));
  for (const f of ["egress-relay.js", ...SHARED.filter((f) => f !== "net-guard.mjs")]) fs.copyFileSync(path.join(REPO, "relay", f), path.join(rel, f));
  fs.copyFileSync(path.join(REPO, "relay/systemd/enclave-egress-relay.service"), path.join(rel, "systemd/enclave-egress-relay.service"));
  if (checkoutU7) fs.appendFileSync(path.join(rel, "fleet.mjs"), U7);
  // a TRANSITIVE-only dependency: fleet.mjs imports ./extra.mjs, which egress-relay.js does not import itself
  if (extra) { fs.appendFileSync(path.join(rel, "fleet.mjs"), EXTRA_IMPORT); fs.writeFileSync(path.join(rel, "extra.mjs"), EXTRA); }
  const root = path.join(w, "host"), d = path.join(root, "opt/nan-relay");
  if (host !== "absent") fs.mkdirSync(d, { recursive: true });
  if (host === "identical") {
    // the host holds this repo's own (pre-change) bytes, as regular files the way scp leaves them; a U7 checkout or host
    // is then made by appending to ONE side only
    for (const f of SHARED) fs.writeFileSync(path.join(d, f), fs.readFileSync(path.join(REPO, "relay", f)));
    fs.writeFileSync(path.join(d, "egress-relay.js"), "// the host's current egress relay\n");
    for (const f of others) fs.writeFileSync(path.join(d, f), `// ${f}\n`);
    fs.mkdirSync(path.join(d, "node_modules"));
    if (hostU7) fs.appendFileSync(path.join(d, "fleet.mjs"), U7);
    if (extra) {
      fs.appendFileSync(path.join(d, "fleet.mjs"), EXTRA_IMPORT);
      if (extra !== "missing") fs.writeFileSync(path.join(d, "extra.mjs"), extra === "differ" ? EXTRA + "// another revision\n" : EXTRA);
    }
    if (drop) fs.rmSync(path.join(d, drop));
    if (change) fs.appendFileSync(path.join(d, change), "\n// another revision\n");
  }
  const bin = path.join(w, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ssh"), STUB_SSH, { mode: 0o755 }); fs.writeFileSync(path.join(bin, "scp"), STUB_SCP, { mode: 0o755 });
  return { w, co, root, bin, log: path.join(w, "log.jsonl"), stdin: path.join(w, "stdin.txt") };
}
function run(W, args = []) {
  const env = { PATH: `${W.bin}:${process.env.PATH}`, HOME: W.w, NAN_RELAY: "nan-relay-stub", STUB_LOG: W.log, STUB_ROOT: W.root, STUB_TOKEN: TOKEN, STUB_STDIN: W.stdin };
  const r = spawnSync("bash", [path.join(W.co, "scripts/deploy-us-west-egress.sh"), ...args], { encoding: "utf8", env, timeout: 60_000 });
  const calls = fs.existsSync(W.log) ? fs.readFileSync(W.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { code: r.status, out: r.stdout + r.stderr, calls, stdin: fs.existsSync(W.stdin) ? fs.readFileSync(W.stdin, "utf8") : "" };
}
const isProbe = (c) => c.tool === "ssh" && c.cmd.startsWith("d=/opt/nan-relay;");
const isReach = (c) => c.tool === "ssh" && c.cmd.includes("reached $(hostname)");
const scpToRelay = (r) => r.calls.filter((c) => c.tool === "scp" && c.args.at(-1).endsWith(":/opt/nan-relay/")).flatMap((c) => c.args.slice(0, -1).map((p) => path.basename(p)));
function refusedBeforeAnything(r, re) {
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /REFUSED .* Nothing was written\./);
  if (re) assert.match(r.out, re);
  assert.deepEqual(r.calls.map((c) => (isReach(c) ? "reach" : isProbe(c) ? "probe" : `${c.tool}:${c.cmd || c.args.join(" ")}`)), ["reach", "probe"],
    "only the reachability check and the read-only probe: no token pull, no mkdir, no scp, no remote script");
  assert.ok(!r.out.includes(TOKEN));
}

test("the script derives its shared set itself, and it is egress-relay.js's import closure plus the npm manifests (connlog.mjs included)", () => {
  assert.ok(SHARED.includes("connlog.mjs") && SHARED.includes("fleet.mjs") && SHARED.includes("net-guard.mjs"), SHARED.join(" "));
  const r = run(world());
  const line = r.out.split("\n").find((l) => l.includes("shared modules this egress relay needs:"));
  assert.ok(line, r.out);
  assert.deepEqual(line.split(": ")[1].trim().split(" ").sort(), [...SHARED].sort(), "a new local import must change this list, or CI fails here");
});

test("EXISTING host, shared modules identical (net-guard.mjs through the checkout's symlink): only egress-relay.js and its unit are written, after the probe", () => {
  const r = run(world());
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(scpToRelay(r), ["egress-relay.js"], "no shared module is written to an existing host");
  assert.ok(r.calls.some((c) => c.tool === "scp" && c.args.at(-1).endsWith(":/etc/systemd/system/")));
  assert.ok(!r.calls.some((c) => c.tool === "ssh" && c.cmd.includes("mkdir -p /opt/nan-relay")));
  const iProbe = r.calls.findIndex(isProbe), iToken = r.calls.findIndex((c) => c.tool === "ssh" && c.host === "nan-relay-stub");
  const iWrite = r.calls.findIndex((c) => c.tool === "scp" || (c.tool === "ssh" && (c.cmd.includes("mkdir") || c.cmd.includes("bash -s"))));
  assert.ok(iProbe >= 0 && iProbe < iToken && iToken < iWrite, `the probe decides before the token is pulled and before any write: ${r.calls.map((c) => c.tool + ":" + (c.host || "")).join(", ")}`);
  assert.ok(!r.out.includes(TOKEN), "the token is never printed");
});

test("an OLD checkout against a U7 host (the host's fleet.mjs has startEligibility, this one's does not): REFUSED before any write or token pull", () => {
  refusedBeforeAnything(run(world({ hostU7: true })), /fleet\.mjs \(host [0-9a-f]{12}…, this checkout [0-9a-f]{12}…\).*relay\.js/);
});

test("a U7 checkout against a pre-U7 host (the reverse): REFUSED too; an egress relay is never written beside shared modules it was not written against", () => {
  refusedBeforeAnything(run(world({ checkoutU7: true })), /fleet\.mjs/);
});

test("an existing host MISSING a shared module (connlog.mjs), or with another lockfile: REFUSED", () => {
  refusedBeforeAnything(run(world({ drop: "connlog.mjs" })), /connlog\.mjs \(host missing/);
  refusedBeforeAnything(run(world({ change: "package-lock.json" })), /package-lock\.json/);
});

test("--bootstrap on an EXISTING host: REFUSED", () => {
  refusedBeforeAnything(run(world(), ["--bootstrap"]), /--bootstrap is for a fresh host/);
});

test("a FRESH host (no /opt/nan-relay, or an empty one) is refused without --bootstrap", () => {
  refusedBeforeAnything(run(world({ host: "absent" })), /pass --bootstrap/);
  refusedBeforeAnything(run(world({ host: "empty" })), /pass --bootstrap/);
});

test("a FRESH host with --bootstrap gets the egress relay and its WHOLE closure, then npm ci", () => {
  const r = run(world({ host: "absent" }), ["--bootstrap"]);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(scpToRelay(r).sort(), ["egress-relay.js", ...SHARED].sort());
  assert.ok(r.calls.some((c) => c.tool === "ssh" && c.cmd.includes("mkdir -p /opt/nan-relay")));
  const remote = r.calls.find((c) => c.tool === "ssh" && c.cmd.includes("bash -s"));
  assert.ok(remote && (remote.cmd.includes("NPM_CI='1'") || r.stdin.includes("NPM_CI=1")), "npm ci runs on the manifests just written");
  assert.match(r.stdin, /mkdir -p \/etc\/nan-relay/, "a fresh host has no /etc/nan-relay yet");
});

test("usage: an unknown flag, or two aliases, is refused before anything is contacted", () => {
  for (const args of [["--egress-only-host"], ["--force"], ["a", "b"]]) {
    const r = run(world(), args);
    assert.equal(r.code, 2, `${args}: ${r.out}`); assert.deepEqual(r.calls, []);
  }
});

test("the token reaches the remote ONLY on stdin: in no argv (local or remote), in no output, quoted so a quote cannot break out", () => {
  for (const [host, args] of [["identical", []], ["absent", ["--bootstrap"]]]) {
    const r = run(world({ host }), args);
    assert.equal(r.code, 0, r.out);
    for (const c of r.calls) assert.ok(!JSON.stringify(c).includes(TOKEN), `the token is in an argv: ${JSON.stringify(c).slice(0, 160)}`);
    assert.ok(!r.out.includes(TOKEN), "nor in the script's output");
    const remote = r.calls.find((c) => c.tool === "ssh" && c.cmd.includes("bash -s"));
    assert.equal(remote.cmd, "bash -s", "the remote command is exactly `bash -s`");
    assert.equal(r.stdin.split("\n")[0], `TOKEN=${TOKEN}`, "the token is the remote script's first line, on stdin");
  }
  // a token with a quote and a command substitution in it stays one inert assignment (bash's own %q, parsed by bash)
  const W = world({ host: "absent" }), nasty = "t'o\"k$(touch /tmp/pwned)`id`";
  const env = { PATH: `${W.bin}:${process.env.PATH}`, HOME: W.w, EGRESS_RELAY_TOKEN: nasty, STUB_LOG: W.log, STUB_ROOT: W.root, STUB_STDIN: W.stdin };
  const r = spawnSync("bash", [path.join(W.co, "scripts/deploy-us-west-egress.sh"), "--bootstrap"], { encoding: "utf8", env, timeout: 60_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const first = fs.readFileSync(W.stdin, "utf8").split("\n")[0];
  const back = spawnSync("bash", ["-c", `${first}; printf %s "$TOKEN"`], { encoding: "utf8" });
  assert.equal(back.stdout, nasty, "bash reads the line back as exactly the token, and runs nothing");
});

// The REMOTE script as the stub received it on stdin, run locally in a sandbox: /opt/nan-relay and /etc/nan-relay moved
// under a temp dir, systemctl/journalctl/npm/sleep recorded or stubbed, and mktemp/cat/chmod/mv able to fail on demand.
const REAL = Object.fromEntries(["mktemp", "cat", "chmod", "sync", "mv", "grep", "rm"].map((c) => [c, spawnSync("sh", ["-c", `command -v ${c}`], { encoding: "utf8" }).stdout.trim()]));
function remoteRun(stdin, { fail = null, token = null, quietJournal = false } = {}) {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), "egress-deploy-remote-")); WORLDS.push(box);
  const etc = path.join(box, "etc"), opt = path.join(box, "opt"), bin = path.join(box, "bin"), svc = path.join(box, "svc.log");
  for (const d of [etc, path.join(opt, "node_modules"), bin]) fs.mkdirSync(d, { recursive: true });
  const env = path.join(etc, "egress-relay.env"), OLD = "EGRESS_RELAY_TOKEN=the-working-token\nRELAY_NAME=us-west\n";
  fs.writeFileSync(env, OLD); fs.chmodSync(env, 0o644);
  for (const c of ["systemctl", "journalctl", "npm"]) fs.writeFileSync(path.join(bin, c), `#!/bin/sh\necho "${c} $*" >> "${svc}"\n`, { mode: 0o755 });
  // a healthy relay's journal line (unless this run asks for a quiet journal)
  if (!quietJournal) fs.appendFileSync(path.join(bin, "journalctl"), `echo "egress relay: control channel up"\n`);
  fs.writeFileSync(path.join(bin, "sleep"), "#!/bin/sh\n", { mode: 0o755 });
  for (const [c, real] of Object.entries(REAL)) if (c !== "grep" && c !== "rm")
    fs.writeFileSync(path.join(bin, c), `#!/bin/sh\n${c === "mktemp" ? `echo "$*" >> "${path.join(box, "mktemp.args")}"\n` : ""}if [ "$FAIL_AT" = "${c}" ]; then ${c === "cat" ? "exec >/dev/null; " : ""}echo "stub: ${c} fails" >&2; exit 1; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
  let script = stdin.split("/etc/nan-relay").join(etc).split("/opt/nan-relay").join(opt);
  if (token !== null) script = script.replace(/^TOKEN=.*$/m, `TOKEN=${token}`);
  const r = spawnSync("bash", ["-s"], { input: script, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, FAIL_AT: fail || "" } });
  return { code: r.status, err: r.stderr, bytes: fs.readFileSync(env, "utf8"), mode: fs.statSync(env).mode & 0o777, OLD,
           left: fs.readdirSync(etc).filter((f) => f !== "egress-relay.env"), svc: fs.existsSync(svc) ? fs.readFileSync(svc, "utf8") : "", etc,
           mktempArgs: fs.existsSync(path.join(box, "mktemp.args")) ? fs.readFileSync(path.join(box, "mktemp.args"), "utf8").trim() : null };
}

test("the env update REPLACES the working file only when its complete successor is ready: success is mode 600, the new token, no temp left, then the service", () => {
  const r0 = run(world(), []);
  assert.equal(r0.code, 0, r0.out);
  const r = remoteRun(r0.stdin);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.mode, 0o600); assert.match(r.bytes, new RegExp(`^EGRESS_RELAY_TOKEN=${TOKEN}$`, "m")); assert.ok(!r.bytes.includes("the-working-token"));
  assert.deepEqual(r.left, [], "no temporary file is left beside it");
  assert.equal(r.mktempArgs, `${r.etc}/.egress-relay.env.XXXXXX`, "the temporary file is made IN the env file's directory (one filesystem: the rename is atomic)");
  assert.match(r.svc, /systemctl daemon-reload\nsystemctl enable --now enclave-egress-relay/);
  assert.ok(!r.err.includes(TOKEN) && !r.svc.includes(TOKEN), "the token is in no log and no argv the stubs saw");
});

test("every failure BEFORE the rename leaves the working env file byte-for-byte (and its mode), removes the temporary file, and runs NO service action", () => {
  const r0 = run(world(), []);
  for (const [what, opt] of [["mktemp fails", { fail: "mktemp" }], ["writing the settings fails", { fail: "cat" }], ["chmod fails", { fail: "chmod" }], ["sync fails", { fail: "sync" }],
                             ["the rename itself fails", { fail: "mv" }], ["the settings are incomplete (no token)", { token: "''" }]]) {
    const r = remoteRun(r0.stdin, opt);
    assert.notEqual(r.code, 0, `${what}: the remote script must stop`);
    assert.equal(r.bytes, r.OLD, `${what}: the working file's bytes survive`);
    assert.equal(r.mode, 0o644, `${what}: and its mode (nothing touched it)`);
    assert.deepEqual(r.left, [], `${what}: no temporary file is left`);
    assert.equal(r.svc.split("\n").filter((l) => l.startsWith("systemctl")).length, 0, `${what}: no service action after the failure (${r.svc})`);
  }
});
test("the closure is TRANSITIVE: a module only fleet.mjs imports (extra.mjs) is derived, checked, and refused when the host's differs or lacks it (enclave-99's E2)", () => {
  const W = world({ extra: "same" });
  assert.deepEqual(closure(path.join(W.co, "relay")).sort(), [...closure(path.join(REPO, "relay")), "extra.mjs"].sort(), "the fixture's own closure gains extra.mjs");
  const r = run(W);
  assert.equal(r.code, 0, r.out);
  const line = r.out.split("\n").find((l) => l.includes("shared modules this egress relay needs:"));
  assert.ok(line.split(": ")[1].trim().split(" ").includes("extra.mjs"), `extra.mjs, imported only by fleet.mjs, is in the derived set: ${line}`);
  assert.deepEqual(scpToRelay(r), ["egress-relay.js"]);
  refusedBeforeAnything(run(world({ extra: "differ" })), /extra\.mjs \(host [0-9a-f]{12}…/);
  refusedBeforeAnything(run(world({ extra: "missing" })), /extra\.mjs \(host missing/);
  const b = run(world({ host: "absent", extra: "same" }), ["--bootstrap"]);
  assert.equal(b.code, 0, b.out); assert.ok(scpToRelay(b).includes("extra.mjs"), "--bootstrap ships the transitive module too");
});

test("a quiet journal after a good start is not reported as a failure (the journal grep is diagnostic; `systemctl is-active` is the check)", () => {
  const r0 = run(world(), []);
  const quiet = remoteRun(r0.stdin, { quietJournal: true });
  assert.equal(quiet.code, 0, `a quiet journal must not fail the remote step: ${quiet.err}`);
});
