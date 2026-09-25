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
function world({ checkoutU7 = false, host = "identical", hostU7 = false, drop = null, change = null, others = ["relay.js", "api-relay.js"] } = {}) {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), "egress-deploy-")); WORLDS.push(w);
  const co = path.join(w, "checkout"), rel = path.join(co, "relay");
  fs.mkdirSync(path.join(co, "scripts"), { recursive: true }); fs.mkdirSync(path.join(rel, "systemd"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "scripts/deploy-us-west-egress.sh"), path.join(co, "scripts/deploy-us-west-egress.sh"));
  fs.copyFileSync(path.join(REPO, "net-guard.mjs"), path.join(co, "net-guard.mjs"));
  fs.symlinkSync("../net-guard.mjs", path.join(rel, "net-guard.mjs"));
  for (const f of ["egress-relay.js", ...SHARED.filter((f) => f !== "net-guard.mjs")]) fs.copyFileSync(path.join(REPO, "relay", f), path.join(rel, f));
  fs.copyFileSync(path.join(REPO, "relay/systemd/enclave-egress-relay.service"), path.join(rel, "systemd/enclave-egress-relay.service"));
  if (checkoutU7) fs.appendFileSync(path.join(rel, "fleet.mjs"), U7);
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
