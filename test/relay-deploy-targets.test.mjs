// relay/deploy.sh run for real against fake hosts: no network, no real ssh/scp/npm/node registry access. The script's
// own bash executes; ssh/scp/node/npm on PATH are fakes that log every call. A fake "remote" command really runs (bash)
// inside that host's own root directory, where /opt and /etc are mapped, with fake systemctl/journalctl/pgrep/npm/node
// that model a unit (its installed WorkingDirectory/ExecStart, restart, is-active, the code it is running). So the
// assertions are about effects - which host was contacted, which files landed where, which unit restarted, what the
// host is serving afterwards - not about the script's wording.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const exe = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "#!/usr/bin/env bash\n" + body); fs.chmodSync(file, 0o755); };

// ---- fakes -------------------------------------------------------------------------------------------------------
const SSH_COMMON = `
args=("$@"); i=0; opts=()
while [ $i -lt \${#args[@]} ]; do case "\${args[$i]}" in -o) opts+=("\${args[$((i+1))]}"); i=$((i+2));; -q) i=$((i+1));; -*) echo "fake: unexpected option \${args[$i]}" >&2; exit 96;; *) break;; esac; done
for o in BatchMode=yes StrictHostKeyChecking=yes ConnectTimeout=15; do [[ " \${opts[*]} " == *" $o "* ]] || { echo "fake: missing -o $o" >&2; exit 97; }; done
rest=("\${args[@]:$i}")
`;
const LOCAL_SSH = SSH_COMMON + `
host="\${rest[0]}"; cmd="\${rest[*]:1}"
printf 'ssh %s :: %s\\n' "$host" "$cmd" >> "$FAKE/log"
H="$FAKE/hosts/\${host#*@}"
[ -d "$H" ] && [ ! -e "$H/unreachable" ] || exit 255
[[ "$cmd" != *pgrep* ]] || [ ! -e "$H/ssh-fail-pgrep" ] || exit 255
# the connection drops at the API apply: nothing runs, nothing comes back
[[ "$cmd" != "bash -s -- "*" enclave-api-relay "* ]] || [ ! -e "$H/drop-api-apply" ] || exit 255
cmd=$(printf '%s' "$cmd" | sed -e "s#/opt/#$H/root/opt/#g" -e "s#/etc/#$H/root/etc/#g")
export FAKE_HOST_DIR="$H"
PATH="$FAKE/remotebin:/usr/bin:/bin" exec bash -c "$cmd"
`;
const LOCAL_SCP = SSH_COMMON + `
dest="\${rest[\${#rest[@]}-1]}"; files=("\${rest[@]:0:\${#rest[@]}-1}")
printf 'scp %s :: %s\\n' "$dest" "\${files[*]}" >> "$FAKE/log"
host="\${dest%%:*}"; p="\${dest#*:}"; H="$FAKE/hosts/\${host#*@}"
[ -d "$H" ] && [ ! -e "$H/unreachable" ] || exit 255
case "$p" in /opt/*|/etc/*) ;; *) echo "fake scp: unmapped path $p" >&2; exit 98;; esac
t="$H/root$p"
cp "\${files[@]}" "$t" || exit 1
if [ -e "$H/corrupt-copy" ] && [[ "$t" == */ ]]; then printf 'tampered' >> "$t$(basename "\${files[0]}")"; fi
`;
const LOCAL_NODE = `
printf 'node %s\\n' "$*" >> "$FAKE/log"
case "$1" in
  */preflight.mjs) exit "\${FAKE_PREFLIGHT_RC:-0}" ;;
  build-network.mjs) [ -z "\${FAKE_BUILD_FAIL:-}" ] || exit 1; printf 'export {};\\n// %s\\n' "$FAKE_BUILD_ID" > network-runtime.bundle.mjs; printf '{"inputs":{}}\\n' > network-runtime.bundle.mjs.manifest.json ;;
  *) echo "fake node: unexpected $*" >&2; exit 99 ;;
esac`;
const LOCAL_NPM = `
printf 'npm %s (cwd %s)\\n' "$*" "$(basename "$PWD")" >> "$FAKE/log"
[ -z "\${FAKE_LOCAL_NPM_FAIL:-}" ] || exit 1
[[ " $* " == *" ci "* && " $* " == *" --ignore-scripts "* ]] || { echo "fake npm: only locked, script-free installs" >&2; exit 95; }
mkdir -p node_modules/esbuild node_modules/viem`;
// remote side: $FAKE_HOST_DIR is the host; $FAKE_HOST_DIR/units/<unit> holds what systemctl show prints
const R_SYSTEMCTL = `
H="$FAKE_HOST_DIR"; printf 'remote %s systemctl %s\\n' "$(basename "$H")" "$*" >> "$FAKE/log"
unitfile() { echo "$H/units/$1"; }
case "$1" in
  show) u="$2"; if [ -f "$(unitfile "$u")" ]; then cat "$(unitfile "$u")"; else printf 'LoadState=not-found\\nWorkingDirectory=\\nExecStart=\\n'; fi ;;
  restart)
    u="$2"; f="$(unitfile "$u")"; [ -f "$f" ] || exit 5
    wd=$(sed -n 's/^WorkingDirectory=//p' "$f"); entry=$(sed -n 's/^ExecStart=.*argv\\[\\]=[^ ]* \\([^ ]*\\) ;.*/\\1/p' "$f")
    d="$H/root$wd"; e="$H/root$entry"
    echo "$(date +%s%N) $u" >> "$H/restarts"
    if [ -f "$e" ] && [ -f "$d/node_modules/.ok" ] && ! grep -q __FAIL_START__ "$e"; then echo active > "$H/state-$u"; sha256sum "$e" | cut -d' ' -f1 > "$H/running-$u"
    else echo failed > "$H/state-$u"; : > "$H/running-$u"; fi ;;
  is-active) u="\${@: -1}"; [ "$(cat "$H/state-$u" 2>/dev/null)" = active ] ;;
  *) echo "fake systemctl: unexpected $*" >&2; exit 90 ;;
esac`;
const R_JOURNAL = `echo "-- fake journal for $* --"`;
const R_PGREP = `
H="$FAKE_HOST_DIR"; printf 'remote %s pgrep %s\\n' "$(basename "$H")" "$*" >> "$FAKE/log"
[ ! -e "$H/pgrep-error" ] || exit 2
n=$(cat "$H/predicting" 2>/dev/null || echo 0)
if [ "$n" = forever ]; then exit 0; fi
if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$H/predicting"; exit 0; fi
exit 1`;
const R_NPM = `
H="$FAKE_HOST_DIR"; printf 'remote %s npm %s (in %s)\\n' "$(basename "$H")" "$*" "\${PWD#$H/root}" >> "$FAKE/log"
[[ " $* " == *" ci "* && " $* " == *" --omit=dev "* && " $* " == *" --ignore-scripts "* ]] || { echo "fake remote npm: locked, script-free, production-only installs only" >&2; exit 95; }
[ -f package-lock.json ] || exit 94
[ ! -e "$H/fail-npm" ] || { echo "registry unavailable" >&2; exit 1; }
mkdir -p node_modules && touch node_modules/.ok`;
const R_NODE = `
H="$FAKE_HOST_DIR"; printf 'remote %s node %s (in %s)\\n' "$(basename "$H")" "$*" "\${PWD#$H/root}" >> "$FAKE/log"
[ -f "$1" ] && [ ! -e "$H/fail-bundle" ]`;

// ---- a sandbox: the relay source tree (real files, real lists) + fakes + hosts -----------------------------------------
const API_UNIT = (dir) => `LoadState=loaded\nWorkingDirectory=${dir}\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${dir}/api-relay.js ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n`;
const DNS_UNIT = (dir) => `LoadState=loaded\nWorkingDirectory=${dir}\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node ${dir}/dns-relay.js ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\n`;
function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-deploy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"), relay = path.join(repo, "relay");
  // real copies (dereference): a test that edits a sandbox file must never write through a symlink into the source tree
  fs.cpSync(path.join(REPO, "relay"), relay, { recursive: true, dereference: true, filter: (s) => !/\/node_modules(\/|$)|network-runtime\.bundle\.mjs/.test(s) });
  fs.mkdirSync(path.join(repo, "network"), { recursive: true }); fs.writeFileSync(path.join(repo, "network/preflight.mjs"), "// not executed: the fake node answers\n");
  for (const f of fs.readdirSync(relay, { recursive: true })) assert.equal(fs.lstatSync(path.join(relay, f)).isSymbolicLink(), false, `sandbox ${f} is a real file`);
  const bin = path.join(root, "bin"), rbin = path.join(root, "remotebin");
  exe(path.join(bin, "ssh"), LOCAL_SSH); exe(path.join(bin, "scp"), LOCAL_SCP); exe(path.join(bin, "node"), LOCAL_NODE); exe(path.join(bin, "npm"), LOCAL_NPM);
  exe(path.join(rbin, "systemctl"), R_SYSTEMCTL); exe(path.join(rbin, "journalctl"), R_JOURNAL); exe(path.join(rbin, "pgrep"), R_PGREP);
  exe(path.join(rbin, "npm"), R_NPM); exe(path.join(rbin, "node"), R_NODE);
  fs.mkdirSync(path.join(root, "hosts")); fs.mkdirSync(path.join(root, "home"));
  const host = (name, { api = null, dns = null } = {}) => {
    const H = path.join(root, "hosts", name);
    fs.mkdirSync(path.join(H, "units"), { recursive: true });
    fs.mkdirSync(path.join(H, "root/etc/nan-relay"), { recursive: true });
    fs.writeFileSync(path.join(H, "root/etc/nan-relay/api-relay.env"), "PROVISIONER_PRIVATE_KEY=0xSECRET-NEVER-READ\n", { mode: 0o600 });
    fs.writeFileSync(path.join(H, "root/etc/nan-relay/dns.env"), "UPLOAD_KEY=SECRET-NEVER-READ\n", { mode: 0o644 });
    // an existing install: the old release of a few shipped files, its dependencies, and host-owned files the deploy must keep
    const install = (unit, unitText, dir, entry) => {
      const d = path.join(H, "root", dir);
      fs.mkdirSync(path.join(d, "node_modules"), { recursive: true }); fs.writeFileSync(path.join(d, "node_modules/.ok"), "old deps\n");
      fs.writeFileSync(path.join(d, entry), `// old ${entry}\n`); fs.writeFileSync(path.join(d, "fleet.mjs"), "// old fleet\n");
      fs.writeFileSync(path.join(d, "operator-notes.txt"), "host-owned\n"); fs.mkdirSync(path.join(d, "state"), { recursive: true });
      fs.writeFileSync(path.join(d, "state/accounts.json"), "{\"host\":\"owned\"}\n");
      fs.writeFileSync(path.join(H, "units", unit), unitText(dir));
      fs.writeFileSync(path.join(H, `state-${unit}`), "active\n"); fs.writeFileSync(path.join(H, `running-${unit}`), sha(path.join(d, entry)) + "\n");
    };
    if (api) install("enclave-api-relay", API_UNIT, api, "api-relay.js");
    if (dns) install("enclave-dns", DNS_UNIT, dns, "dns-relay.js");
    return H;
  };
  const run = (env = {}, args = []) => {
    const r = spawnSync("bash", [path.join(relay, "deploy.sh"), ...args], { encoding: "utf8", timeout: 60000,
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(root, "home"), FAKE: root, FAKE_BUILD_ID: "build-1",
        PREDICTION_POLL_SEC: "1", RELAY_RESTART_SETTLE_SEC: "0", ...env } });
    const log = fs.existsSync(path.join(root, "log")) ? fs.readFileSync(path.join(root, "log"), "utf8") : "";
    return { ...r, log, lines: log.split("\n").filter(Boolean) };
  };
  return { root, relay, host, run, H: (n) => path.join(root, "hosts", n) };
}
const BOTH = (apiHost, dnsHost, apiDir = "/opt/nan-relay", dnsDir = "/opt/enclave-dns") => ({ RELAY_DEPLOY_ROLES: "api,dns",
  RELAY_API_TARGET: `root@${apiHost}`, RELAY_API_DIR: apiDir, RELAY_DNS_TARGET: `root@${dnsHost}`, RELAY_DNS_DIR: dnsDir });
// a tree as { relative path: sha256 } (node_modules collapsed to its marker)
const tree = (dir) => { const out = {}; const walk = (d, rel = "") => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const r = rel + e.name; if (e.isDirectory()) walk(path.join(d, e.name), r + "/"); else out[r] = sha(path.join(d, e.name)); } }; if (fs.existsSync(dir)) walk(dir); return out; };
const restarts = (H) => fs.existsSync(path.join(H, "restarts")) ? fs.readFileSync(path.join(H, "restarts"), "utf8").trim().split("\n").map((l) => l.split(" ")[1]) : [];
const running = (H, u) => fs.readFileSync(path.join(H, `running-${u}`), "utf8").trim();
// the payload lists, read from the script's own scp lines (the same lines test/relay-deploy-closure.test.mjs walks)
function payload(relay, role) {
  const files = [];
  for (const line of fs.readFileSync(path.join(relay, "deploy.sh"), "utf8").split("\n")) {
    const m = line.match(/^scp\s+(.+?)\s+"\$(API|DNS)_TARGET":"\$(API|DNS)_STAGE"\/(\S*)$/);
    if (m && m[2] === role) for (const f of m[1].split(/\s+/)) files.push(m[4] + path.basename(f));
  }
  return files.sort();
}

// ---- configuration refusals: no external action at all ---------------------------------------------------------------
test("missing configuration names the exact role and variable, and nothing is contacted, built or run", (t) => {
  const s = sandbox(t);
  for (const [env, want] of [
    [{}, /RELAY_DEPLOY_ROLES is not set/],
    [{ RELAY_DEPLOY_ROLES: "api" }, /role api: RELAY_API_TARGET is not set/],
    [{ RELAY_DEPLOY_ROLES: "api", RELAY_API_TARGET: "root@a.example" }, /role api: RELAY_API_DIR is not set/],
    [{ RELAY_DEPLOY_ROLES: "api,dns", RELAY_API_TARGET: "root@a.example", RELAY_API_DIR: "/opt/nan-relay" }, /role dns: RELAY_DNS_TARGET is not set/],
    [{ RELAY_DEPLOY_ROLES: "dns", RELAY_DNS_TARGET: "root@a.example" }, /role dns: RELAY_DNS_DIR is not set/]]) {
    const r = s.run(env);
    assert.equal(r.status, 2, JSON.stringify(env)); assert.match(r.stderr, want);
    assert.equal(r.log, "", "no ssh, scp, node or npm ran");
  }
  // the legacy aliases and variables select nothing
  const legacy = s.run({ DNS_HOST: "nan-relay", RELAY_SSH_HOST: "203.0.113.1", SITE_SSH_HOST: "203.0.113.2" });
  assert.equal(legacy.status, 2); assert.equal(legacy.log, "");
});

test("malicious or malformed targets, directories and roles are refused before any side effect", (t) => {
  const s = sandbox(t); const pwn = path.join(s.root, "pwned");
  const ok = { RELAY_DEPLOY_ROLES: "api", RELAY_API_TARGET: "root@a.example", RELAY_API_DIR: "/opt/nan-relay" };
  for (const target of [`-oProxyCommand=touch ${pwn}`, `a.example;touch ${pwn}`, "a.example:22", "a example", `$(touch ${pwn})`, "`id`", "a.example/x", "root@-x", "-x", "ROOT@a.example", "a..b.", "user@@a.example"])
    { const r = s.run({ ...ok, RELAY_API_TARGET: target }); assert.equal(r.status, 2, target); assert.match(r.stderr, /RELAY_API_TARGET must be/); assert.equal(r.log, "", target); }
  for (const dir of ["/opt/../etc", "/opt/..", "/etc/nan-relay", "opt/nan-relay", `/opt/x;touch ${pwn}`, "/opt/a/b", "/opt/.hidden", "/opt/x y", "/opt/$(id)", "/opt/", "/opt/nan-relay/", "/opt/a..b"])
    { const r = s.run({ ...ok, RELAY_API_DIR: dir }); assert.equal(r.status, 2, dir); assert.match(r.stderr, /RELAY_API_DIR must be/); assert.equal(r.log, "", dir); }
  for (const roles of ["api,web", "web", " , ", "api;dns", "API"])
    { const r = s.run({ ...ok, RELAY_DEPLOY_ROLES: roles }); assert.equal(r.status, 2, roles); assert.equal(r.log, "", roles); }
  for (const [k, v] of [["PREDICTION_WAIT_SEC", "1e9"], ["PREDICTION_POLL_SEC", "0"], ["RELAY_RESTART_SETTLE_SEC", "-1"]])
    { const r = s.run({ ...ok, [k]: v }); assert.equal(r.status, 2, k); assert.equal(r.log, "", k); }
  const same = s.run({ ...BOTH("a.example", "a.example", "/opt/nan-relay", "/opt/nan-relay") });
  assert.equal(same.status, 2); assert.match(same.stderr, /same directory/); assert.equal(same.log, "");
  assert.equal(fs.existsSync(pwn), false, "nothing was executed from a value");
  const check = s.run({ ...BOTH("a.example", "b.example") }, ["--check-config"]);
  assert.equal(check.status, 0); assert.match(check.stdout, /role api: root@a\.example:\/opt\/nan-relay \(unit enclave-api-relay\)/); assert.match(check.stdout, /role dns: root@b\.example:\/opt\/enclave-dns/);
  assert.equal(check.log, "", "--check-config contacts nothing");
});

// ---- refusals after configuration: preflight, reachability, unit agreement, predictor ---------------------------------
test("a preflight refusal stops the deploy before any host is contacted", (t) => {
  const s = sandbox(t); s.host("box", { api: "/opt/nan-relay", dns: "/opt/enclave-dns" });
  const before = tree(s.H("box"));
  const r = s.run({ ...BOTH("box", "box"), FAKE_PREFLIGHT_RC: "1" }, ["--require", "0xabc"]);
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.lines, ["node ../network/preflight.mjs --require 0xabc"], "preflight ran (with its arguments) and nothing else");
  assert.deepEqual(tree(s.H("box")), before);
});

test("an unreachable selected DNS host fails the whole deploy: nothing is copied or restarted anywhere", (t) => {
  const s = sandbox(t); const api = s.host("api", { api: "/opt/nan-relay" }); const dns = s.host("dns", { dns: "/opt/enclave-dns" });
  fs.writeFileSync(path.join(dns, "unreachable"), "");
  const before = tree(api);
  const r = s.run(BOTH("api", "dns"));
  assert.equal(r.status, 1); assert.match(r.stderr, /role dns: root@dns does not answer ssh.*nothing was copied or restarted/);
  assert.ok(!r.lines.some((l) => l.startsWith("scp ")), "no copy"); assert.deepEqual(restarts(api), []);
  assert.ok(!r.lines.some((l) => /mkdir/.test(l)), "no staging directory");
  assert.deepEqual(tree(api), before, "the reachable API host is untouched too");
  assert.doesNotMatch(r.stdout, /deployed:/);
});

test("the predictor check fails closed: ssh failure (255) or a pgrep error refuses; nothing is copied or restarted", (t) => {
  for (const flag of ["ssh-fail-pgrep", "pgrep-error"]) {
    const s = sandbox(t); const H = s.host("box", { api: "/opt/nan-relay", dns: "/opt/enclave-dns" }); fs.writeFileSync(path.join(H, flag), "");
    const before = tree(path.join(H, "root"));
    const r = s.run(BOTH("box", "box"));
    assert.equal(r.status, 1, flag); assert.match(r.stderr, /cannot tell whether a measurement prediction is running on root@box \(exit (255|2)\)/);
    assert.ok(!r.lines.some((l) => l.startsWith("scp ")), flag); assert.deepEqual(restarts(H), [], flag);
    assert.deepEqual(tree(path.join(H, "root")), before, flag);
  }
});

test("an active prediction: bounded wait then refusal; a gap within the budget proceeds", (t) => {
  const s = sandbox(t); const H = s.host("box", { api: "/opt/nan-relay" });
  fs.writeFileSync(path.join(H, "predicting"), "forever");
  const t0 = Date.now(), r = s.run({ RELAY_DEPLOY_ROLES: "api", RELAY_API_TARGET: "root@box", RELAY_API_DIR: "/opt/nan-relay", PREDICTION_WAIT_SEC: "3" });
  const took = Date.now() - t0;
  assert.equal(r.status, 1); assert.match(r.stderr, /running on root@box at every look for 3s/);
  assert.ok(took >= 3000 && took < 15000, `bounded wait: ${took} ms`);
  assert.equal(r.lines.filter((l) => /pgrep/.test(l) && l.startsWith("remote")).length, 4, "looks at 0,1,2,3 s");
  assert.ok(!r.lines.some((l) => l.startsWith("scp ")) && restarts(H).length === 0);
  fs.writeFileSync(path.join(H, "predicting"), "2");   // busy for two looks, then a gap
  const ok = s.run({ RELAY_DEPLOY_ROLES: "api", RELAY_API_TARGET: "root@box", RELAY_API_DIR: "/opt/nan-relay", PREDICTION_WAIT_SEC: "10" });
  assert.equal(ok.status, 0, ok.stderr); assert.deepEqual(restarts(H), ["enclave-api-relay"]);
});

test("the installed unit must agree with the named directory: the old blind /opt/nan-relay DNS target is refused", (t) => {
  const s = sandbox(t); const H = s.host("box", { api: "/opt/nan-relay", dns: "/opt/enclave-dns" });
  const before = tree(path.join(H, "root"));
  // the previous script shipped DNS into /opt/nan-relay; the installed enclave-dns runs from /opt/enclave-dns
  const wrong = s.run({ RELAY_DEPLOY_ROLES: "dns", RELAY_DNS_TARGET: "root@box", RELAY_DNS_DIR: "/opt/nan-relay" });
  assert.equal(wrong.status, 1); assert.match(wrong.stderr, /role dns: the enclave-dns unit on root@box does not run \/opt\/nan-relay\/dns-relay\.js from WorkingDirectory=\/opt\/nan-relay \(found: LoadState=loaded WorkingDirectory=\/opt\/enclave-dns/);
  // a directory that is not the installed one (here: does not even exist) is refused with what was found
  const stale = s.run({ RELAY_DEPLOY_ROLES: "api", RELAY_API_TARGET: "root@box", RELAY_API_DIR: "/opt/enclave-api" });
  assert.equal(stale.status, 1); assert.match(stale.stderr, /role api: the enclave-api-relay unit on root@box does not run \/opt\/enclave-api\/api-relay\.js .*WorkingDirectory=\/opt\/nan-relay/);
  fs.rmSync(path.join(H, "units/enclave-dns"));
  const missing = s.run(BOTH("box", "box"));
  assert.equal(missing.status, 1); assert.match(missing.stderr, /role dns: the enclave-dns unit .*LoadState=not-found/);
  for (const r of [wrong, stale, missing]) { assert.ok(!r.lines.some((l) => l.startsWith("scp ")), "no copy"); }
  assert.deepEqual(restarts(H), []); assert.deepEqual(tree(path.join(H, "root")), before);
});

// ---- staging failures: the old processes keep serving -----------------------------------------------------------------
test("source, copy, dependency and bundle staging failures restart nothing and leave the installs unchanged", (t) => {
  for (const [why, arrange, env] of [
    ["remote locked install fails", (H) => fs.writeFileSync(path.join(H, "fail-npm"), ""), {}],
    ["bundle does not load on the box", (H) => fs.writeFileSync(path.join(H, "fail-bundle"), ""), {}],
    ["a copied file does not match the manifest", (H) => fs.writeFileSync(path.join(H, "corrupt-copy"), ""), {}],
    ["local locked install fails", () => {}, { FAKE_LOCAL_NPM_FAIL: "1" }],
    ["local bundle build fails", () => {}, { FAKE_BUILD_FAIL: "1" }]]) {
    const s = sandbox(t); const H = s.host("box", { api: "/opt/nan-relay", dns: "/opt/enclave-dns" }); arrange(H);
    const installs = { api: tree(path.join(H, "root/opt/nan-relay")), dns: tree(path.join(H, "root/opt/enclave-dns")) };
    const served = { api: running(H, "enclave-api-relay"), dns: running(H, "enclave-dns") };
    const r = s.run({ ...BOTH("box", "box"), ...env });
    assert.notEqual(r.status, 0, why);
    assert.deepEqual(restarts(H), [], `${why}: nothing restarted`);
    assert.deepEqual({ api: tree(path.join(H, "root/opt/nan-relay")), dns: tree(path.join(H, "root/opt/enclave-dns")) }, installs, `${why}: installs unchanged`);
    assert.deepEqual({ api: running(H, "enclave-api-relay"), dns: running(H, "enclave-dns") }, served, `${why}: old releases still serving`);
    assert.deepEqual(fs.readdirSync(path.join(H, "root/opt")).sort(), ["enclave-dns", "nan-relay"], `${why}: staging removed`);
    if (env.FAKE_LOCAL_NPM_FAIL || env.FAKE_BUILD_FAIL) assert.ok(!r.lines.some((l) => l.startsWith("scp ")), `${why}: nothing copied`);
  }
});

// ---- success ------------------------------------------------------------------------------------------------------------
test("a successful deploy ships each role's exact closure to its own directory, keeps host state, and restarts each unit once", (t) => {
  const s = sandbox(t); const H = s.host("box", { api: "/opt/nan-relay", dns: "/opt/enclave-dns" });
  const keep = ["etc/nan-relay/api-relay.env", "etc/nan-relay/dns.env", "opt/nan-relay/operator-notes.txt", "opt/nan-relay/state/accounts.json", "opt/enclave-dns/operator-notes.txt", "opt/enclave-dns/state/accounts.json"];
  const kept = Object.fromEntries(keep.map((f) => [f, sha(path.join(H, "root", f))]));
  const r = s.run(BOTH("box", "box"));
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /deployed: api dns/);
  assert.deepEqual(restarts(H), ["enclave-dns", "enclave-api-relay"], "each unit restarted exactly once, DNS first");
  for (const [dir, role, unit, entry] of [["opt/nan-relay", "API", "enclave-api-relay", "api-relay.js"], ["opt/enclave-dns", "DNS", "enclave-dns", "dns-relay.js"]]) {
    const got = tree(path.join(H, "root", dir));
    const shipped = payload(s.relay, role);
    assert.ok(shipped.length >= (role === "API" ? 70 : 9), `${role} payload parsed (${shipped.length})`);
    // exactly the payload (byte-identical to the source), plus node_modules and the host's own files
    assert.deepEqual(Object.keys(got).filter((f) => !f.startsWith("node_modules/") && !["operator-notes.txt", "state/accounts.json"].includes(f)).sort(), shipped, role);
    for (const f of shipped) assert.equal(got[f], sha(path.join(s.relay, f.startsWith("vendor/") || f.startsWith("fixtures/") ? f : path.basename(f))), `${role} ${f}`);
    assert.equal(running(H, unit), got[entry], `${unit} now runs the shipped ${entry}`);
    assert.ok(fs.readdirSync(path.join(H, "root/opt")).some((d) => d.startsWith(path.basename(dir) + ".rollback-")), `${role}: previous release kept for rollback`);
  }
  assert.ok(!Object.keys(tree(path.join(H, "root/opt/enclave-dns"))).includes("api-relay.js"), "roles stay separate on one host");
  for (const [f, h] of Object.entries(kept)) assert.equal(sha(path.join(H, "root", f)), h, `host state kept: ${f}`);
  assert.ok(!fs.readdirSync(path.join(H, "root/opt")).some((d) => d.includes(".deploy-")), "staging removed");
  // contacted: only the selected target; copies: only into the roles' staging directories; no unit files written
  for (const l of r.lines.filter((x) => x.startsWith("ssh ") || x.startsWith("scp "))) assert.match(l, /^(ssh root@box ::|scp root@box:\/opt\/(nan-relay|enclave-dns)\.deploy-[0-9TZ]+-[0-9]+\/)/, l);
  assert.ok(!fs.existsSync(path.join(H, "root/etc/systemd")), "no unit was installed or replaced");
  assert.ok(r.lines.some((l) => /^remote box npm ci --omit=dev --ignore-scripts --no-audit --no-fund \(in \/opt\/nan-relay\.deploy-/.test(l)), "locked install in the API staging directory");
  assert.ok(r.lines.some((l) => /^remote box npm ci .*\(in \/opt\/enclave-dns\.deploy-/.test(l)), "locked install in the DNS staging directory");
  assert.ok(r.lines.some((l) => /^remote box node network-runtime\.bundle\.mjs \(in \/opt\/nan-relay\.deploy-/.test(l)), "bundle load check");
  // preflight, then the read-only checks, then copies: the order the safety gates promise
  const first = (re) => r.lines.findIndex((l) => re.test(l));
  assert.ok(first(/^node .*preflight/) === 0 && first(/pgrep/) < first(/^scp /) && first(/systemctl show/) < first(/^scp /));
  // env files: modes reported, contents never read
  assert.match(r.stdout, /!! \S+dns\.env is mode 644/); assert.match(r.stdout, /ok \S+api-relay\.env mode 600/);
  assert.doesNotMatch(r.stdout + r.stderr + r.log, /SECRET-NEVER-READ/);
});

test("only the selected role is touched; separate hosts get only their own payload", (t) => {
  const s = sandbox(t); const api = s.host("api", { api: "/opt/nan-relay", dns: "/opt/enclave-dns" }); const dns = s.host("dns", { dns: "/opt/enclave-dns" });
  const dnsBefore = tree(path.join(api, "root/opt/enclave-dns"));
  const one = s.run({ RELAY_DEPLOY_ROLES: "api", RELAY_API_TARGET: "root@api", RELAY_API_DIR: "/opt/nan-relay" });
  assert.equal(one.status, 0, one.stderr); assert.match(one.stdout, /the dns role was not selected/);
  assert.deepEqual(restarts(api), ["enclave-api-relay"]); assert.deepEqual(tree(path.join(api, "root/opt/enclave-dns")), dnsBefore);
  assert.equal(one.lines.some((l) => l.includes("root@dns")), false);
  const two = s.run(BOTH("api", "dns"));
  assert.equal(two.status, 0, two.stderr);
  assert.deepEqual(restarts(dns), ["enclave-dns"]); assert.deepEqual(restarts(api), ["enclave-api-relay", "enclave-api-relay"]);
  assert.ok(two.lines.filter((l) => l.startsWith("scp root@dns:")).every((l) => !/api-relay\.js/.test(l)));
  assert.equal(two.lines.filter((l) => /pgrep/.test(l) && l.startsWith("ssh root@dns")).length, 0, "the predictor is checked on the API host");
});

test("a release that does not stay up is rolled back; the DNS-deployed/API-failed mixed state is reported as such", (t) => {
  const s = sandbox(t); const H = s.host("box", { api: "/opt/nan-relay", dns: "/opt/enclave-dns" });
  fs.appendFileSync(path.join(s.relay, "api-relay.js"), "\n// __FAIL_START__\n");
  const before = tree(path.join(H, "root/opt/nan-relay")), served = running(H, "enclave-api-relay");
  const r = s.run(BOTH("box", "box"));
  assert.equal(r.status, 1); assert.match(r.stdout, /enclave-api-relay FAILED to stay up/);
  assert.match(r.stdout, /^APPLY-RESULT status=committed rc=0 .*enclave-dns\.rollback-/m, "the box reported the DNS commit");
  assert.match(r.stdout, /^APPLY-RESULT status=restored-active rc=70 .*nan-relay\.rollback-/m, "and the API rollback, as it happened");
  assert.match(r.stderr, /role api: enclave-api-relay on root@box: the new release failed \(exit 70\); the previous release was restored and is active/);
  assert.match(r.stderr, /MIXED STATE: the dns role was deployed on root@box and keeps serving the new release; the api role was not\. The previous DNS release is saved in root@box:\/opt\/enclave-dns\.rollback-/);
  assert.match(r.stdout, /^role api: restored-active$/m); assert.match(r.stdout, /^role dns: committed$/m);
  assert.deepEqual(tree(path.join(H, "root/opt/nan-relay")), before, "the API install is exactly the old one (new-only files removed)");
  assert.equal(running(H, "enclave-api-relay"), served, "and the old code serves again");
  assert.deepEqual(restarts(H), ["enclave-dns", "enclave-api-relay", "enclave-api-relay"]);
  assert.match(fs.readFileSync(path.join(H, "root/opt", fs.readdirSync(path.join(H, "root/opt")).find((d) => d.startsWith("nan-relay.rollback-")), "STATUS"), "utf8"), /^status=restored-active rc=70$/m);
  assert.doesNotMatch(r.stdout, /deployed:/);
});

test("a connection lost during the API apply is reported as an UNKNOWN outcome, never as restored", (t) => {
  const s = sandbox(t); const H = s.host("box", { api: "/opt/nan-relay", dns: "/opt/enclave-dns" });
  fs.writeFileSync(path.join(H, "drop-api-apply"), "");
  const r = s.run(BOTH("box", "box"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /role api: enclave-api-relay on root@box: no final status \(ssh exit 255\): the outcome is UNKNOWN; the box records it in root@box:\/opt\/nan-relay\.rollback-\S+\/STATUS/);
  assert.doesNotMatch(r.stderr, /restored/); assert.match(r.stdout, /^role api: unknown$/m); assert.match(r.stderr, /MIXED STATE/);
});
