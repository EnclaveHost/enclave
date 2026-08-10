// wasm/wasm_manager.py — catalog rev-7 large configs: the delivery split.
//
// A version's ENCLAVE_CONFIG can now live at an IPFS CID instead of inline,
// which lifts the 4096-byte on-chain ceiling to CONFIG_MAX_BYTES (1 MB). That
// runs straight into a KERNEL limit the old path never could: the config is
// handed to wasmtime as a single `--env ENCLAVE_CONFIG=…` argv string, and
// execve refuses any one argument over MAX_ARG_STRLEN (32 pages = 131072 bytes)
// with E2BIG. So past CONFIG_ENV_MAX_BYTES the config is delivered by FILE and
// the env var is dropped.
//
// The bug this pins down existed BEFORE rev 7 and was merely unreachable:
// CONFIG_MAX_BYTES was 256 KB, twice the kernel wall, so a 150 KB config would
// have validated and then died at spawn with a bare E2BIG. Raising the ceiling
// is what makes it reachable.
//
//   run: node --test test/wasm-config-cid.test.mjs   (needs python3 on PATH)

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WASM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "wasm");

// Linux MAX_ARG_STRLEN: 32 pages. Nothing may put more than this in one argv
// entry, so it is the hard ceiling the env channel has to stay under.
const MAX_ARG_STRLEN = 32 * 4096;

function py(src) {
  return JSON.parse(execFileSync("python3", ["-c",
    `import sys, json\nsys.path.insert(0, ${JSON.stringify(WASM_DIR)})\nimport wasm_manager as m\n${src}`,
  ], { encoding: "utf8" }).trim().split("\n").pop());
}

// Build a command for a config of `n` bytes and report which channels it used.
function channels(n, { cfgdir = "/tmp/cfgdir" } = {}) {
  return py(`
cfg = '{"k":"' + "x" * ${n} + '"}'
try:
    cmd, _port, _wait = m._build_cmd(m._parse_ports([]), "/tmp/a.wasm", 8080, 1 << 20,
                                     enclave_config=cfg, cfgdir=${cfgdir === null ? "None" : JSON.stringify(cfgdir)})
except ValueError as e:
    print(json.dumps({"ok": False, "err": str(e)}))
else:
    envs = [cmd[i + 1] for i, a in enumerate(cmd) if a == "--env"]
    dirs = [cmd[i + 1] for i, a in enumerate(cmd) if a == "--dir"]
    longest = max(len(a.encode()) for a in cmd)
    print(json.dumps({"ok": True,
                      "inline": any(a.startswith("ENCLAVE_CONFIG=") for a in envs),
                      "file": any(a.startswith("ENCLAVE_CONFIG_FILE=") for a in envs),
                      "dirs": dirs, "longest": longest}))
`);
}

test("the ceilings are ordered so the env channel can never hit E2BIG", () => {
  const c = py(`print(json.dumps({"max": m.CONFIG_MAX_BYTES, "env": m.CONFIG_ENV_MAX_BYTES}))`);
  assert.ok(c.env < MAX_ARG_STRLEN,
    `CONFIG_ENV_MAX_BYTES (${c.env}) must stay under MAX_ARG_STRLEN (${MAX_ARG_STRLEN}) — ` +
    `this is the check that was missing when CONFIG_MAX_BYTES was 256 KB`);
  assert.ok(c.max > c.env, "the file channel only earns its keep if configs may exceed the env one");
  assert.equal(c.max, 1024 * 1024, "the spam ceiling: 1 MB");
});

test("a small config rides the env var AND the file", () => {
  const r = channels(100);
  assert.equal(r.ok, true, r.err);
  assert.equal(r.inline, true, "every app written before rev 7 reads only ENCLAVE_CONFIG");
  assert.equal(r.file, true, "…and the file is always there, so one mechanism works at any size");
});

test("a config past the env ceiling is delivered by file only", () => {
  const r = channels(200 * 1024);
  assert.equal(r.ok, true, r.err);
  assert.equal(r.inline, false, "an oversize argv entry is E2BIG at execve, not a truncated env var");
  assert.equal(r.file, true);
  assert.ok(r.dirs.some((d) => d.endsWith("::/config")), `config dir not preopened: ${r.dirs}`);
});

test("no argv entry can exceed the kernel's per-argument limit", () => {
  for (const n of [1024, 60 * 1024, 200 * 1024, 900 * 1024]) {
    const r = channels(n);
    assert.equal(r.ok, true, r.err);
    assert.ok(r.longest < MAX_ARG_STRLEN,
      `a ${n}-byte config produced a ${r.longest}-byte argv entry (limit ${MAX_ARG_STRLEN})`);
  }
});

test("a large config with no config dir REFUSES rather than launching configless", () => {
  // The file is the only channel up here. Starting anyway would serve the app
  // with no config at all, which looks healthy and is silently wrong.
  const r = channels(200 * 1024, { cfgdir: null });
  assert.equal(r.ok, false);
  assert.match(r.err, /env ceiling/);
});

test("a small config with no config dir still starts on the env var alone", () => {
  const r = channels(100, { cfgdir: null });
  assert.equal(r.ok, true, r.err);
  assert.equal(r.inline, true);
  assert.equal(r.file, false);
});

test("_validate_config enforces the 1 MB ceiling and rejects non-JSON", () => {
  const over = py(`
try:
    m._validate_config("x" * (m.CONFIG_MAX_BYTES + 1))
    print(json.dumps({"ok": True}))
except ValueError as e:
    print(json.dumps({"ok": False, "err": str(e)}))
`);
  assert.equal(over.ok, false);
  assert.match(over.err, /exceeds/);

  const bad = py(`
try:
    m._validate_config("not json")
    print(json.dumps({"ok": True}))
except ValueError as e:
    print(json.dumps({"ok": False, "err": str(e)}))
`);
  assert.equal(bad.ok, false);
  assert.match(bad.err, /not valid JSON/);
});

test("teardown removes the read-only /config drop rather than silently failing", () => {
  // The dir is 0500 so a tenant cannot write there — but rmtree needs WRITE on
  // a directory to unlink its children, so a plain rmtree(ignore_errors=True)
  // would leave it behind. A staged config holds substituted secrets, so a
  // cleanup that silently no-ops outlives the tenant entitled to them.
  const r = py(`
import os, tempfile, pathlib
d = pathlib.Path(tempfile.mkdtemp()) / "app_x-cfg"
d.mkdir()
f = d / "config.json"
f.write_text('{"secret":"hunter2"}')
f.chmod(0o400)
d.chmod(0o500)
m._rm_tree_rw(str(d))
print(json.dumps({"gone": not d.exists()}))
`);
  assert.equal(r.gone, true, "the staged config dir survived teardown");
});

test("the config drop is charged against the tenant's storage cap", () => {
  // /config is a preopen on the shared ramdisk. If it were unmeasured it would
  // be a hole straight through the /data ceiling.
  const r = py(`
import tempfile, pathlib
d = pathlib.Path(tempfile.mkdtemp())
(d / "config.json").write_text("x" * (m.CONFIG_DIR_SLACK_BYTES + 8192))
rec = {"id": "app_x", "_cfgdir": str(d), "_cfgBytes": 10, "_fsdir": None, "storageMb": 0,
       "status": "running", "_proc": None}
m._audit_storage(rec)
print(json.dumps({"status": rec["status"], "err": rec.get("error") or ""}))
`);
  assert.equal(r.status, "failed", "a /config that grew past its staged size must be caught");
  assert.match(r.err, /config/);
});

test("a config CID must look like a CID before any fetch is attempted", () => {
  // Same rule as _resolve_cid for the wasm: reject, never sanitize. A sanitized
  // key would let two different CIDs collapse onto one.
  for (const bad of ["", "short", "has/slash", "has.dot", "x".repeat(101)]) {
    const r = py(`
try:
    m._resolve_config_cid(${JSON.stringify(bad)})
    print(json.dumps({"ok": True}))
except ValueError as e:
    print(json.dumps({"ok": False, "err": str(e)}))
`);
    assert.equal(r.ok, false, `'${bad}' should be refused`);
    assert.match(r.err, /bad config cid|not available/);
  }
});
