// The remote half of relay/deploy.sh (APPLY), executed for real exactly as the box receives it (`bash -s -- dir stage
// unit id settle` with the script on stdin), in a temp directory, against fake systemctl/journalctl and cp/mv wrappers
// that inject failures (or a signal to the running APPLY) at a chosen file operation. Every case compares the whole
// install - contents AND modes - with the original, checks what the service ran, and checks the reported outcome.
// The frozen original APPLY (test/fixtures/relay-deploy-apply-6019b92b.sh) is the negative control: it must still show
// the defect these cases guard against.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const extract = (script) => { const a = script.indexOf("APPLY='") + 7; return script.slice(a, script.indexOf("'\n", a)); };
const APPLY = extract(fs.readFileSync(path.join(REPO, "relay/deploy.sh"), "utf8"));
const ORIGINAL = fs.readFileSync(path.join(REPO, "test/fixtures/relay-deploy-apply-6019b92b.sh"), "utf8");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const exe = (f, body) => { fs.writeFileSync(f, "#!/usr/bin/env bash\n" + body); fs.chmodSync(f, 0o755); };
const ID = "20261020T120000Z-4242";

// fakes: a match on the joined arguments fails the call (exit 61) or signals the APPLY shell (the caller's parent)
const FAULTY = (real) => `
args="$*"; n="$FAKE/count-$(basename "$0")"; c=$(( $(cat "$n" 2>/dev/null || echo 0) + 1 )); echo $c > "$n"
if [ -n "\${FAULT_SIGNAL:-}" ] && [[ "$args" =~ \${FAULT_SIGNAL_MATCH} ]] && [ ! -e "$FAKE/signalled" ]; then : > "$FAKE/signalled"; kill -s "$FAULT_SIGNAL" "$PPID"; fi
if [ -n "\${FAULT_${real.toUpperCase()}:-}" ] && [[ "$args" =~ \${FAULT_${real.toUpperCase()}} ]]; then echo "injected $(basename "$0") failure: $args" >&2; exit 61; fi
exec /usr/bin/${real} "$@"`;
const SYSTEMCTL = `
printf '%s\\n' "$*" >> "$FAKE/systemctl.log"
case "$1" in
  restart)
    n=$(( $(cat "$FAKE/restarts" 2>/dev/null || echo 0) + 1 )); echo $n > "$FAKE/restarts"
    if [ "\${FAULT_RESTART_CALL:-}" = "$n" ]; then echo "injected restart failure" >&2; exit 1; fi
    # signal the APPLY shell (our parent is \`timeout\`; its parent is the shell) once, during the first restart
    if [ -n "\${FAULT_SIGNAL_RESTART:-}" ] && [ "$n" = 1 ]; then kill -s "$FAULT_SIGNAL_RESTART" "$(ps -o ppid= -p "$PPID" | tr -d ' ')"; fi
    if grep -q FAIL_START "$LIVE/a.mjs" || [ -n "\${FAULT_ALWAYS_DOWN:-}" ]; then echo failed > "$FAKE/state"; else echo active > "$FAKE/state"; fi
    sha256sum "$LIVE/a.mjs" | cut -d' ' -f1 > "$FAKE/running" ;;
  is-active) [ "$(cat "$FAKE/state")" = active ] ;;
  *) exit 90 ;;
esac`;

function fixture(t, { newA = "export const a = 'new';\n" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-apply-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const live = path.join(root, "opt/app"), stage = `${live}.deploy-${ID}`, bin = path.join(root, "bin");
  const w = (f, s, mode) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); if (mode) fs.chmodSync(f, mode); };
  // the running install: old releases of three shipped files (one with an unusual mode), its dependencies, and
  // host-owned files the manifest does not name; beside it an env file, a unit and an older rollback directory
  w(path.join(live, "a.mjs"), "export const a = 'old';\n", 0o640); w(path.join(live, "b.mjs"), "old b\n"); w(path.join(live, "c.mjs"), "old c\n");
  w(path.join(live, "operator.txt"), "host-owned\n"); w(path.join(live, "state/db.json"), "{\"owned\":1}\n", 0o600);
  w(path.join(live, "node_modules/old-dep/index.js"), "old dependency\n");
  w(path.join(root, "etc/app/app.env"), "SECRET=never-touched\n", 0o600); w(path.join(root, "etc/systemd/system/app.service"), "[Service]\nWorkingDirectory=/opt/app\n");
  w(path.join(root, "opt/app.rollback-older/files/a.mjs"), "older\n");
  // the staged release: new versions, one new file, one file in a new subdirectory, new dependencies, the manifest
  const ship = { "a.mjs": newA, "b.mjs": "new b\n", "c.mjs": "new c\n", "n.mjs": "new file\n", "vendor/v.mjs": "vendored\n" };
  for (const [f, s] of Object.entries(ship)) w(path.join(stage, f), s);
  w(path.join(stage, "node_modules/new-dep/index.js"), "new dependency\n");
  w(path.join(stage, ".deploy-manifest"), Object.entries(ship).map(([f, s]) => `${sha(s)}  ${f}\n`).join(""));
  fs.mkdirSync(bin); exe(path.join(bin, "cp"), FAULTY("cp")); exe(path.join(bin, "mv"), FAULTY("mv"));
  exe(path.join(bin, "systemctl"), SYSTEMCTL); exe(path.join(bin, "journalctl"), `echo "-- fake journal: $* --"`);
  fs.writeFileSync(path.join(root, "state"), "active\n"); fs.writeFileSync(path.join(root, "running"), sha("export const a = 'old';\n") + "\n");
  // everything except the staging and rollback directories (and the fakes' own bookkeeping)
  const snapshot = () => { const out = {}; const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const r = rel + e.name, p = path.join(d, e.name);
    if (rel === "opt/" && /\.(deploy-|rollback-)|\.deploy\.lock$/.test(e.name)) continue;
    if (e.isDirectory()) { out[r + "/"] = (fs.statSync(p).mode & 0o7777).toString(8); walk(p, r + "/"); }
    else out[r] = `${(fs.statSync(p).mode & 0o7777).toString(8)} ${sha(fs.readFileSync(p))}`; } };
    for (const top of ["opt", "etc"]) walk(path.join(root, top), top + "/"); return out; };
  const run = (env = {}, script = APPLY, args = [live, stage, "app", ID, "0"]) => {
    const r = spawnSync("bash", ["-s", "--", ...args], { input: script, encoding: "utf8", timeout: 30000,
      env: { PATH: `${bin}:/usr/bin:/bin`, FAKE: root, LIVE: live, ...env } });
    const results = [...(r.stdout || "").matchAll(/^APPLY-RESULT status=(\S+) rc=(\d+)/gm)];
    return { ...r, result: results.length ? { status: results.at(-1)[1], rc: Number(results.at(-1)[2]) } : null };
  };
  const read = (f) => fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8").trim() : null;
  return { root, live, stage, back: `${live}.rollback-${ID}`, snapshot, run, read, running: () => read("running"), restarts: () => Number(read("restarts") || 0) };
}
// a failure after which the install must be EXACTLY the original and the unit, never restarted, still serving it
function assertRestoredUnrestarted(f, before, r, rc) {
  assert.equal(r.status, rc, r.stdout + r.stderr); assert.deepEqual(r.result, { status: "restored-unrestarted", rc });
  assert.deepEqual(f.snapshot(), before, "the install, its modes, dependencies, host files, env and unit are exactly the original");
  assert.equal(f.restarts(), 0, "a failure before the restart does not restart anything");
  assert.equal(f.running(), sha("export const a = 'old';\n"), "the previous release kept serving");
  assert.match(f.read(`opt/app.rollback-${ID}/STATUS`), /^status=restored-unrestarted rc=\d+$/);
}

test("success: exactly the manifest files and dependencies change, host state stays, older rollbacks go", (t) => {
  const f = fixture(t); const before = f.snapshot();
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.stderr); assert.deepEqual(r.result, { status: "committed", rc: 0 });
  const after = f.snapshot();
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k]).sort();
  assert.deepEqual(changed, ["opt/app/a.mjs", "opt/app/b.mjs", "opt/app/c.mjs", "opt/app/n.mjs", "opt/app/node_modules/new-dep/", "opt/app/node_modules/new-dep/index.js",
    "opt/app/node_modules/old-dep/", "opt/app/node_modules/old-dep/index.js", "opt/app/vendor/", "opt/app/vendor/v.mjs"]);
  assert.equal(f.restarts(), 1); assert.equal(f.running(), sha("export const a = 'new';\n"));
  assert.equal(fs.existsSync(f.stage), false); assert.equal(fs.existsSync(path.join(f.root, "opt/app.rollback-older")), false);
  assert.equal(fs.readFileSync(path.join(f.back, "files/a.mjs"), "utf8"), "export const a = 'old';\n", "this release's rollback copy is kept");
});

test("a copy failure at the first file or midway restores the exact original; the unit is never restarted", (t) => {
  for (const [where, fault] of [["first file", "a\\.mjs\\.deploy-tmp"], ["midway", "c\\.mjs\\.deploy-tmp"], ["the new file", "n\\.mjs\\.deploy-tmp"], ["the new subdirectory", "v\\.mjs\\.deploy-tmp"]]) {
    const f = fixture(t); const before = f.snapshot();
    const r = f.run({ FAULT_CP: `app\\.deploy-.* .*${fault}` });
    assertRestoredUnrestarted(f, before, r, 61);
    assert.equal(fs.existsSync(path.join(f.live, "vendor")), false, `${where}: a directory this release created is removed again`);
  }
});

test("a failed rename of a copied file (mv) is undone too, leaving no temporary files", (t) => {
  const f = fixture(t); const before = f.snapshot();
  const r = f.run({ FAULT_MV: "b\\.mjs\\.deploy-tmp" });
  assertRestoredUnrestarted(f, before, r, 61);
  assert.deepEqual(fs.readdirSync(f.live).filter((x) => /deploy-tmp|rollback-tmp/.test(x)), []);
});

test("each dependency move failing is undone: the old node_modules is back in place", (t) => {
  for (const fault of [`app\\.deploy-${ID}/node_modules .*app/node_modules\\.deploy-`, "app/node_modules .*rollback-.*/node_modules", `app/node_modules\\.deploy-${ID} .*app/node_modules$`]) {
    const f = fixture(t); const before = f.snapshot();
    const r = f.run({ FAULT_MV: fault });
    assertRestoredUnrestarted(f, before, r, 61);
    assert.equal(fs.readFileSync(path.join(f.live, "node_modules/old-dep/index.js"), "utf8"), "old dependency\n", fault);
  }
});

test("a release that does not stay up, or a failing restart command, is rolled back and the old release restarted", (t) => {
  const crash = fixture(t, { newA: "export const a = 'new'; // FAIL_START\n" }); const before = crash.snapshot();
  const r = crash.run();
  assert.equal(r.status, 70); assert.deepEqual(r.result, { status: "restored-active", rc: 70 });
  assert.match(r.stdout, /app FAILED to stay up after restart/);
  assert.deepEqual(crash.snapshot(), before); assert.equal(crash.restarts(), 2, "the new release, then the restored one");
  assert.equal(crash.running(), sha("export const a = 'old';\n"));
  const cmd = fixture(t); const before2 = cmd.snapshot();
  const r2 = cmd.run({ FAULT_RESTART_CALL: "1" });
  assert.equal(r2.status, 1); assert.deepEqual(r2.result, { status: "restored-active", rc: 1 });
  assert.deepEqual(cmd.snapshot(), before2); assert.equal(cmd.running(), sha("export const a = 'old';\n"));
  // the restored release does not come up either: reported as such, never as restored-and-active
  const down = fixture(t); const before3 = down.snapshot();
  const r3 = down.run({ FAULT_ALWAYS_DOWN: "1" });
  assert.equal(r3.status, 70); assert.deepEqual(r3.result, { status: "restored-inactive", rc: 70 });
  assert.deepEqual(down.snapshot(), before3, "the files are restored even though the unit is down");
});

test("a failing rollback is reported as such and deletes nothing: saved files, old dependencies, journal and new release stay", (t) => {
  const f = fixture(t);
  // the release fails midway (c.mjs) AND restoring a.mjs from its saved copy fails
  const r = f.run({ FAULT_CP: `(app\\.deploy-.* .*c\\.mjs\\.deploy-tmp|rollback-${ID}/files/a\\.mjs .*a\\.mjs\\.rollback-tmp)` });
  assert.equal(r.status, 61); assert.deepEqual(r.result, { status: "rollback-failed", rc: 61 });
  assert.match(r.stdout, /ROLLBACK FAILED: \S+ is NOT fully restored\. Nothing was deleted/);
  assert.equal(f.read(`opt/app.rollback-${ID}/STATUS`), "status=rollback-failed rc=61");
  assert.equal(fs.readFileSync(path.join(f.back, "files/a.mjs"), "utf8"), "export const a = 'old';\n", "the saved copy is still there");
  assert.match(fs.readFileSync(path.join(f.back, ".journal"), "utf8"), /^file a\.mjs\nfile b\.mjs\nfile c\.mjs\n$/);
  assert.ok(fs.existsSync(f.stage), "the new release is kept"); assert.equal(f.restarts(), 0);
  // what could be undone was: b.mjs is old again; a.mjs is the one that could not be restored
  assert.equal(fs.readFileSync(path.join(f.live, "b.mjs"), "utf8"), "old b\n");
  assert.equal(fs.readFileSync(path.join(f.live, "a.mjs"), "utf8"), "export const a = 'new';\n");
  assert.equal(fs.readFileSync(path.join(f.live, "node_modules/old-dep/index.js"), "utf8"), "old dependency\n");
});

test("a signal during the apply (TERM, HUP, INT) rolls back and keeps the signal's exit status", (t) => {
  for (const [sig, rc] of [["TERM", 143], ["HUP", 129], ["INT", 130]]) {
    const f = fixture(t); const before = f.snapshot();
    const r = f.run({ FAULT_SIGNAL: sig, FAULT_SIGNAL_MATCH: "c\\.mjs\\.deploy-tmp" });
    assertRestoredUnrestarted(f, before, r, rc);
  }
  // a signal during the last dependency move (before any restart)
  const g = fixture(t); const before = g.snapshot();
  assertRestoredUnrestarted(g, before, g.run({ FAULT_SIGNAL: "TERM", FAULT_SIGNAL_MATCH: `app/node_modules\\.deploy-${ID} .*app/node_modules$` }), 143);
  // a signal while the new release is being started: the files are restored and the previous release restarted
  const h = fixture(t); const before2 = h.snapshot();
  const r = h.run({ FAULT_SIGNAL_RESTART: "TERM" });
  assert.equal(r.status, 143, r.stdout + r.stderr); assert.deepEqual(r.result, { status: "restored-active", rc: 143 });
  assert.deepEqual(h.snapshot(), before2); assert.equal(h.restarts(), 2); assert.equal(h.running(), sha("export const a = 'old';\n"));
});

test("failures before any live change, and a held lock, change nothing and say so", (t) => {
  const save = fixture(t); const before = save.snapshot();
  const r = save.run({ FAULT_CP: "^-a .*app/b\\.mjs" });   // saving the old b.mjs fails
  assert.equal(r.status, 61); assert.deepEqual(r.result, { status: "not-changed", rc: 61 });
  assert.deepEqual(save.snapshot(), before); assert.equal(fs.existsSync(save.back), false); assert.equal(save.restarts(), 0);
  const bad = fixture(t); fs.appendFileSync(path.join(bad.stage, ".deploy-manifest"), `${sha("x")}  ../escape.mjs\n`); const before2 = bad.snapshot();
  const r2 = bad.run();
  assert.equal(r2.status, 65); assert.deepEqual(r2.result, { status: "not-changed", rc: 65 }); assert.deepEqual(bad.snapshot(), before2);
  const locked = fixture(t); const before3 = locked.snapshot();
  const holder = spawn("flock", [locked.live + ".deploy.lock", "sleep", "20"], { stdio: "ignore" });
  t.after(() => holder.kill("SIGKILL"));
  for (let i = 0; i < 100 && spawnSync("flock", ["-n", locked.live + ".deploy.lock", "true"]).status === 0; i++) spawnSync("sleep", ["0.05"]);
  const r3 = locked.run();
  assert.equal(r3.status, 75); assert.deepEqual(r3.result, { status: "not-started", rc: 75 });
  assert.deepEqual(locked.snapshot(), before3); assert.equal(fs.existsSync(locked.back), false);
});

test("negative control: the frozen original APPLY leaves the install without its dependencies on the same failures", (t) => {
  assert.equal(sha(ORIGINAL), "d09822a431c504606d453269f01af548d2656be9166a3163acdcc8ad8132090a", "the APPLY of relay/deploy.sh 6019b92b, verbatim");
  for (const fault of ["a\\.mjs\\.deploy-tmp", "c\\.mjs\\.deploy-tmp"]) {
    const f = fixture(t);
    const r = f.run({ FAULT_CP: `app\\.deploy-.* .*${fault}` }, ORIGINAL);
    assert.equal(r.status, 61, fault); assert.equal(r.result, null, "it reports no outcome");
    assert.equal(fs.existsSync(path.join(f.live, "node_modules")), false, `${fault}: the old APPLY moved the live dependencies away and never put them back`);
    assert.equal(f.restarts(), 0);
  }
});


test("a preexisting backup is preserved byte-for-byte; no install, stage or service change", (t) => {
  for (const variant of ["directory", "symlink"]) {
    const f = fixture(t); const before = f.snapshot();
    const actual = variant === "directory" ? f.back : path.join(f.root, "prior-backup");
    fs.mkdirSync(actual); fs.writeFileSync(path.join(actual, "owner-backup"), "do not delete\n", {mode: 0o600});
    fs.writeFileSync(path.join(actual, "STATUS"), "prior-status\n");
    if (variant === "symlink") fs.symlinkSync(actual, f.back);
    const stageBefore = fs.readFileSync(path.join(f.stage, ".deploy-manifest"), "utf8");
    const r = f.run();
    assert.equal(fs.existsSync(f.back), true, variant + ": backup path was deleted");
    assert.equal(fs.readFileSync(path.join(actual, "owner-backup"), "utf8"), "do not delete\n");
    assert.equal(fs.readFileSync(path.join(actual, "STATUS"), "utf8"), "prior-status\n");
    assert.deepEqual(fs.readdirSync(actual).sort(), ["STATUS", "owner-backup"]);
    assert.equal(fs.statSync(path.join(actual, "owner-backup")).mode & 0o777, 0o600);
    assert.equal(fs.lstatSync(f.back).isSymbolicLink(), variant === "symlink");
    assert.equal(r.status, 73, r.stdout + r.stderr);
    assert.deepEqual(r.result, {status: "not-started", rc: 73});
    assert.deepEqual(f.snapshot(), before);
    assert.equal(fs.readFileSync(path.join(f.stage, ".deploy-manifest"), "utf8"), stageBefore);
    assert.equal(f.restarts(), 0);
  }
});
