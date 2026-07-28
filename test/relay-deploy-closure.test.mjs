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
function scpTargets() {
  const out = [];
  for (const line of deploySh.split("\n")) {
    const m = line.match(/^\s*scp\s+(.+?)\s+([A-Za-z0-9_-]+):(\S+)\s*$/);
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
  assert.ok(targets.length >= 2, "expected at least the nan-relay and nan scp lines");

  const missing = [];
  for (const { host, files } of targets) {
    const shipped = new Set(files);
    const seen = new Set();
    const queue = [...files];
    while (queue.length) {
      const rel = queue.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      const abs = path.join(RELAY, rel);
      if (!fs.existsSync(abs)) continue;           // a stale list entry is a different problem
      for (const spec of relativeImports(abs)) {
        // deploy.sh flattens: everything lands in one directory on the box, so
        // the shipped name is the basename regardless of the source layout.
        const dep = path.basename(spec);
        if (!shipped.has(dep)) missing.push(`${host}: ${rel} imports ${spec} — add ${dep} to its scp line`);
        else queue.push(dep);
      }
    }
  }
  assert.deepEqual(missing, [], "unshipped imports would crash-loop the daemon on ERR_MODULE_NOT_FOUND:\n" + missing.join("\n"));
});
