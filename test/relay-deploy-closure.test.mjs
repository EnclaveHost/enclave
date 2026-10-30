// relay/deploy.sh ships an explicit list of files per box. That list is
// maintained by hand, so adding a new module and importing it from a shipped
// entrypoint deploys an entrypoint whose import does not exist on the target.
// Node fails at RESOLVE time, before any code runs, so the daemon cannot even
// start: it crash-loops on ERR_MODULE_NOT_FOUND with the whole API down.
//
// That is exactly what relay/boxhost.js did on 2026-07-28 (api-relay restart
// counter reached 372 before anyone looked). The deploy's own is-active check
// caught it and failed the run — the outage came from shipping a list that
// could not work, not from missing the alarm.
//
// So: every relative import reachable from a shipped entrypoint must itself be
// shipped to the same box. Computed transitively, because a second-level
// import is just as fatal as a first-level one.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const deploySh = fs.readFileSync(path.join(RELAY, "deploy.sh"), "utf8");

// Every `scp <files…> "$<ROLE>_TARGET":"$<ROLE>_STAGE"/<subdir>` line, as { host, dest, files, all }. Only .js/.mjs
// entries are modules; `all` keeps every shipped file (package.json, the lockfile, fixtures).
//
// Targets are explicit per role (API, DNS) - never a literal host alias. EVERY scp command line in the script must be
// one of these: a payload line written any other way would otherwise escape the closure check silently.
function scpTargets() {
  const out = [], unmatched = [];
  for (const line of deploySh.split("\n")) {
    if (!/^\s*scp\s/.test(line)) continue;
    const m = line.match(/^scp\s+(.+?)\s+"\$(API|DNS)_TARGET":"\$(API|DNS)_STAGE"\/(\S*)$/);
    if (!m || m[2] !== m[3]) { unmatched.push(line.slice(0, 120)); continue; }
    const all = m[1].split(/\s+/);
    out.push({ host: m[2], dest: "/" + m[4], all, files: all.filter((f) => /\.(mjs|js)$/.test(f)) });
  }
  assert.deepEqual(unmatched, [], "scp lines this check does not recognise (ship through a role's staging directory):\n" + unmatched.join("\n"));
  return out;
}

// Relative specifiers only: bare ones come from node_modules (npm ci installs
// them on the box from the shipped lockfile) and node: builtins are always there.
function relativeImports(file) {
  const src = fs.readFileSync(file, "utf8");
  const out = new Set();
  for (const re of [/\bfrom\s*["'](\.[^"']+)["']/g, /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g])
    for (const m of src.matchAll(re)) out.add(m[1]);
  return [...out];
}

test("relay/deploy.sh ships every module its entrypoints import, transitively", () => {
  const targets = scpTargets();
  // both roles' payloads must be recognised, or this check silently covers only one of them
  assert.deepEqual([...new Set(targets.map((t) => t.host))].sort(), ["API", "DNS"], "both the API and the DNS payloads must be included in dependency checks");
  for (const [role, entry] of [["API", "api-relay.js"], ["DNS", "dns-relay.js"]]) {
    const shippedHere = targets.filter((t) => t.host === role).flatMap((t) => t.all);
    for (const f of [entry, "package.json", "package-lock.json", "network-runtime.bundle.mjs"])
      assert.ok(shippedHere.includes(f), `${role}: ${f} must ship (entrypoint, locked dependencies, network bundle)`);
    for (const f of shippedHere) if (f !== "network-runtime.bundle.mjs" && f !== "network-runtime.bundle.mjs.manifest.json")
      assert.ok(fs.existsSync(path.join(RELAY, f)), `${role}: deployment lists missing source relay/${f}`);
  }

  // Per host, the box's tree: each scp line lands its files FLAT in its destination directory (scp keeps basenames,
  // not source layout), and a host may have several lines into different directories under one install root
  // (nan: /opt/nan-relay/ and /opt/nan-relay/vendor/ since 2026-09-25). A shipped file is therefore known by its path
  // RELATIVE TO THAT ROOT (the shortest destination among the host's lines), and an import resolves against the
  // importing file's own shipped path, exactly as Node will resolve it on the box.
  const byHost = new Map();
  for (const t of targets) { if (!byHost.has(t.host)) byHost.set(t.host, []); byHost.get(t.host).push(t); }
  const missing = [];
  for (const [host, lines] of byHost) {
    const dests = lines.map((l) => l.dest.replace(/\/+$/, "") + "/");
    const root = dests.slice().sort((a, b) => a.length - b.length)[0];
    const shipped = new Map();                     // shipped path on the box (relative to root) -> source path in relay/
    for (const l of lines) {
      const dir = path.posix.relative(root, l.dest.replace(/\/+$/, "") + "/");
      assert.ok(!dir.startsWith(".."), `${host}: ${l.dest} is not under the install root ${root}`);
      for (const f of l.files) shipped.set(path.posix.join(dir, path.posix.basename(f)), f);
    }
    const seen = new Set();
    const queue = [...shipped.keys()];
    while (queue.length) {
      const rel = queue.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      const abs = path.join(RELAY, shipped.get(rel));
      assert.ok(fs.existsSync(abs), `deployment lists missing source ${abs}`);
      for (const spec of relativeImports(abs)) {
        const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
        if (!shipped.has(dep)) missing.push(`${host}: ${rel} imports ${spec} — ship ${dep} (a scp line into ${root}${path.posix.dirname(dep) === "." ? "" : path.posix.dirname(dep) + "/"})`);
        else queue.push(dep);
      }
    }
  }
  assert.deepEqual(missing, [], "unshipped imports would crash-loop the daemon on ERR_MODULE_NOT_FOUND:\n" + missing.join("\n"));
});

test("the DNS payload boots in a flat directory without the repository, including its attested judge", { timeout: 15000 }, async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "enclave-dns-shipped-"));
  const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  let child, exited;
  try {
    const target = scpTargets().find((t) => t.host === "DNS");
    assert.ok(target, "DNS deployment must have a payload");
    for (const f of [...target.files, "package.json"]) fs.copyFileSync(path.join(RELAY, f), path.join(dir, path.basename(f)));
    assert.equal(fs.existsSync(path.join(dir, "../network/contract-pins.mjs")), false, "no source tree beside the payload");
    const dnsPort = await freePort(), apiPort = await freePort();
    child = spawn(process.execPath, [path.join(dir, "dns-relay.js")], {
      cwd: dir,
      env: { PATH: process.env.PATH, DNS_BIND: "127.0.0.1", DNS_PORT: String(dnsPort),
        DNS_API_BIND: "127.0.0.1", DNS_API_PORT: String(apiPort), NS_NAME: "ns1.flat.test",
        DNS_CHALLENGE_AUTH: "attested", CHALLENGE_ZONE: "challenge.flat.test",
        ATTESTED_MEASUREMENTS: "ab".repeat(48), ATTESTED_JUDGE_MODE: "lab-unsigned", ATTESTED_KDS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = new Promise((resolve) => child.once("exit", resolve));
    let log = "";
    child.stdout.on("data", (b) => { log += b; });
    child.stderr.on("data", (b) => { log += b; });
    child.on("error", (e) => { log += e.message; });
    for (let i = 0; i < 80; i++) {
      const health = await fetch(`http://127.0.0.1:${apiPort}/health`, { signal: AbortSignal.timeout(300) })
        .then((r) => r.json()).catch(() => null);
      if (health?.mode === "attested" && health.zones?.challenge === "challenge.flat.test") return;
      if (child.exitCode !== null) break;
      await delay(100);
    }
    assert.fail(`the shipped DNS payload did not start: ${log}`);
  } finally {
    if (child && child.exitCode === null) { child.kill("SIGKILL"); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
