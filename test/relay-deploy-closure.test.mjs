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

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "relay");
const deploySh = fs.readFileSync(path.join(RELAY, "deploy.sh"), "utf8");

// Every `scp <files…> <host>:<dir>` line, as { host, files }. Only .js/.mjs
// entries matter here; package.json and the systemd units are not modules.
//
// The host is either a literal alias (`nan:`) or the data-plane loop's
// variable (`"$RH":`), which stands for EVERY relay the operator runs. Both
// must be matched: the loop is exactly where a missing module would land on
// several boxes at once, so it is the last line that should escape this check
// by being written differently.
function scpTargets() {
  const out = [];
  for (const line of deploySh.split("\n")) {
    const m = line.match(/^\s*scp\s+(.+?)\s+("?\$?[A-Za-z0-9_{}-]+"?):(\S+)\s*$/);
    if (!m) continue;
    const files = m[1].split(/\s+/).filter((f) => /\.(mjs|js)$/.test(f));
    if (files.length) out.push({ host: m[2], dest: m[3], files });
  }
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
  assert.ok(targets.length >= 2, "expected at least the data-plane relay and api-relay scp lines");
  // the data-plane payload goes out inside the host loop; if that line stops
  // being recognised, this check silently covers only the api relay
  assert.ok(targets.some((t) => /\$RH/.test(t.host)),
    "the looped data-plane scp line must still be parsed - it ships to every relay");

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
      if (!fs.existsSync(abs)) continue;           // a stale list entry is a different problem
      for (const spec of relativeImports(abs)) {
        const dep = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
        if (!shipped.has(dep)) missing.push(`${host}: ${rel} imports ${spec} — ship ${dep} (a scp line into ${root}${path.posix.dirname(dep) === "." ? "" : path.posix.dirname(dep) + "/"})`);
        else queue.push(dep);
      }
    }
  }
  assert.deepEqual(missing, [], "unshipped imports would crash-loop the daemon on ERR_MODULE_NOT_FOUND:\n" + missing.join("\n"));
});
