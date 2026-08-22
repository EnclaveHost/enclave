// Shared-everything threads (SET ⚡), held to the same doctrine as coop
// threads (test/wasm-threads.test.mjs) with the differences that make SET a
// SEPARATE capability: it buys REAL cores (not interleaving), it rides on
// wasip2 (NOT p3), its marker is `[set-spawn-indirect]` (set-componentize's
// wired spawn canon), and its engine flags are the full spawn-intrinsic set
// (threads + shared-everything-threads + component-model-threading +
// shared-memory). HELP TEXT IS A LIAR here too — the probe COMPILES a
// thread.spawn-indirect component, never greps help.
//
// Surfaces pinned here:
//   1. The four `-W` flags are emitted only for a tenant whose bytes need SET
//      (the `[set-spawn-indirect]` sniff), only when the compile probe passed,
//      and never under WASM_SET_THREADS=0. Unlike coop, NOT gated on p3.
//   2. The sniff: SET-componentized bytes carry `[set-spawn-indirect]`
//      verbatim; bytes without it (incl. a coop `[thread-` guest) do not trip.
//   3. Lockstep: the gateway's Python classifier reports the same `set` answer
//      the runner's sniff gives for the same bytes.
//
//   run: node --test test/wasm-set.test.mjs   (needs python3)

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");
const GATEWAY = path.join(REPO, "scripts", "ipfs-add-gateway.py");

const FAKE = (body) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-set-"));
  const p = path.join(dir, "wasmtime");
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
};

// SET does NOT require p3, so the help surface is deliberately p3-LESS: this
// proves the SET path never gates on p3 the way coop threads do.
const HELP_NO_P3 = `echo "  -S    loopback-allow=<port[+port...]> -- ..."; echo "  -W  shared-everything-threads[=y|n] -- ..."; exit 0`;
// compile probe passes: the engine really spawns SET threads
const BIN_SET_OK = `if [ "$1" = "compile" ]; then exit 0; fi; ${HELP_NO_P3}`;
// help ADVERTISES the flag, compile chokes on the spawn intrinsic (the
// unpatched-engine shape). Advertising must count for nothing.
const BIN_HELP_LIAR = `if [ "$1" = "compile" ]; then echo "unsupported intrinsic thread.spawn-indirect" >&2; exit 1; fi; ${HELP_NO_P3}`;

function probe(kw = {}, { serve = true, env = {} } = {}) {
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
pspec = ${serve
    ? '{"serve": True, "http": None, "tcp": [], "udp": [], "declared": [], "norm": []}'
    : '{"serve": False, "http": 8080, "tcp": [8080], "udp": [], "declared": ["tcp:8080"], "norm": ["http:8080"]}'}
cmd, host_port, wait = m._build_cmd(pspec, "/tmp/app.wasm", 20001, 64 * 1024 * 1024,
                                    ${serve ? "None" : '{"http:8080": 20002}'}, None, **json.loads(${JSON.stringify(JSON.stringify(kw))}))
# the four SET flags are emitted as ONE -W with a comma list; verify the token
has_set = "shared-everything-threads" in ",".join(cmd)
print(json.dumps({"cmd": cmd, "hasSet": has_set,
                  "supported": m._set_supported(), "active": m._set_active()}))
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, WASM_MANAGER_PORT: "8091", NODE_HAS_GPU: "0", ...env },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

// ---- 1. the flags -----------------------------------------------------------

test("a proven engine + a SET tenant = the four spawn flags, in both modes", () => {
  const bin = FAKE(BIN_SET_OK);
  for (const serve of [true, false]) {
    const { cmd, hasSet, supported, active } = probe({ set_threads: true }, { serve, env: { WASMTIME_BIN: bin } });
    assert.equal(supported, true);
    assert.equal(active, true);
    assert.ok(hasSet, `${serve ? "serve" : "run"} argv must carry -W shared-everything-threads for a SET tenant`);
    // the full dependency set rides on the same -W
    const joined = cmd.join(" ");
    for (const w of ["threads", "shared-everything-threads", "component-model-threading", "shared-memory"]) {
      assert.ok(joined.includes(w), `SET argv must include ${w}`);
    }
  }
});

// engine accepts the spawn probe but rejects `-W set-epochs` — the shape of a
// box whose wasmtime predates wasmtime-set-epochs.patch. The manager must
// OMIT the flag there, not kill every SET launch with an unrecognized option.
const BIN_SET_OK_NO_EPOCHS_FLAG = `case "$*" in *set-epochs*) echo "unknown -W option: set-epochs" >&2; exit 1;; esac; ${BIN_SET_OK}`;

test("a proven engine gets set-epochs=n on the same -W: SET without the epoch-check tax", () => {
  const bin = FAKE(BIN_SET_OK);
  const { cmd, hasSet } = probe({ set_threads: true }, { env: { WASMTIME_BIN: bin } });
  assert.ok(hasSet);
  assert.ok(cmd.join(" ").includes("set-epochs=n"),
    "a SET tenant on an engine that parses -W set-epochs must launch with set-epochs=n");
});

test("an engine that rejects -W set-epochs gets the four flags WITHOUT it (either release order works)", () => {
  const bin = FAKE(BIN_SET_OK_NO_EPOCHS_FLAG);
  const { cmd, hasSet, active } = probe({ set_threads: true }, { env: { WASMTIME_BIN: bin } });
  assert.equal(active, true, "the spawn probe itself still passes");
  assert.ok(hasSet, "SET flags still emitted");
  assert.ok(!cmd.join(" ").includes("set-epochs"),
    "but set-epochs must be omitted so launches keep working on the old engine");
});

test("WASM_SET_EPOCHS=1 is the kill-switch back to epoch-armed SET", () => {
  const bin = FAKE(BIN_SET_OK);
  const { cmd, hasSet } = probe({ set_threads: true }, { env: { WASMTIME_BIN: bin, WASM_SET_EPOCHS: "1" } });
  assert.ok(hasSet);
  assert.ok(!cmd.join(" ").includes("set-epochs"),
    "the kill-switch must suppress set-epochs=n without a release");
});

test("a tenant WITHOUT the marker never gets the SET flags, even on a capable box", () => {
  const bin = FAKE(BIN_SET_OK);
  const { hasSet, active } = probe({ set_threads: false }, { env: { WASMTIME_BIN: bin } });
  assert.equal(active, true, "the box is capable");
  assert.ok(!hasSet, "but a non-SET tenant does not carry shared-everything-threads");
});

test("help text is a liar: advertising shared-everything-threads without compiling the intrinsic is NOT capability", () => {
  const bin = FAKE(BIN_HELP_LIAR);
  const { hasSet, supported, active } = probe({ set_threads: true }, { env: { WASMTIME_BIN: bin } });
  assert.equal(supported, false);
  assert.equal(active, false);
  assert.ok(!hasSet);
});

test("an unanswerable probe drops the SET flags, not the box", () => {
  const missing = path.join(tmpdir(), "no-such-wasmtime-" + process.pid);
  const { hasSet, supported } = probe({ set_threads: true }, { env: { WASMTIME_BIN: missing } });
  assert.equal(supported, false);
  assert.ok(!hasSet);
});

test("WASM_SET_THREADS=0 is an operator kill-switch over a capable engine", () => {
  const bin = FAKE(BIN_SET_OK);
  const { hasSet, supported, active } = probe({ set_threads: true }, { env: { WASMTIME_BIN: bin, WASM_SET_THREADS: "0" } });
  assert.equal(supported, true, "the engine still compiles the intrinsic");
  assert.equal(active, false, "but the box does not serve SET");
  assert.ok(!hasSet);
});

test("SET does NOT ride on p3: a p3-less box still serves SET (the key difference from coop)", () => {
  // The fake help surface has no p3 token at all, and WASM_P3=0 is set for good
  // measure. Coop threads would be dead here; SET must be alive.
  const bin = FAKE(BIN_SET_OK);
  const { hasSet, active } = probe({ set_threads: true }, { env: { WASMTIME_BIN: bin, WASM_P3: "0" } });
  assert.equal(active, true, "SET is a wasip2 capability, independent of p3");
  assert.ok(hasSet);
});

// ---- 2. the sniff -----------------------------------------------------------

function sniff(bytesJs, fn = "_needs_set_threads") {
  const code = `
import importlib.util, sys, json, pathlib, tempfile
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
d = tempfile.mkdtemp()
p = pathlib.Path(d) / "probe.wasm"
p.write_bytes(bytes(${bytesJs}))
print(json.dumps(m.${fn}(p)))
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, WASM_MANAGER_PORT: "8091", NODE_HAS_GPU: "0" },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("the [set-spawn-indirect] marker trips the SET sniff; its absence does not", () => {
  assert.equal(sniff(`b"\\x00asm\\x0d\\x00\\x01\\x00 [set-spawn-indirect] rest"`), true);
  assert.equal(sniff(`b"\\x00asm\\x0d\\x00\\x01\\x00 no threads here"`), false);
});

test("a coop `[thread-` guest is NOT a SET guest, and vice-versa (independent markers)", () => {
  const coop = `b"\\x00asm\\x0d\\x00\\x01\\x00 [thread-new-indirect-v0]"`;
  const set = `b"\\x00asm\\x0d\\x00\\x01\\x00 [set-spawn-indirect]"`;
  assert.equal(sniff(coop, "_needs_set_threads"), false, "coop marker is not SET");
  assert.equal(sniff(coop, "_needs_coop_threads"), true, "coop marker is coop");
  assert.equal(sniff(set, "_needs_set_threads"), true, "set marker is SET");
  assert.equal(sniff(set, "_needs_coop_threads"), false, "set marker is not coop");
});

// ---- 3. gateway lockstep ----------------------------------------------------

test("the gateway's Python classifier reports the same `set` answer", () => {
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("gw", ${JSON.stringify(GATEWAY)})
g = importlib.util.module_from_spec(spec); sys.modules["gw"] = g
spec.loader.exec_module(g)
setg = b"\\x00asm\\x0d\\x00\\x01\\x00 [set-spawn-indirect]"
plain = b"\\x00asm\\x0d\\x00\\x01\\x00 nothing"
print(json.dumps([g.component_contract(setg)["set"], g.component_contract(plain)["set"]]))
`;
  const out = execFileSync("python3", ["-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(JSON.parse(out.trim().split("\n").pop()), [true, false]);
});

// ---- 4. the full forwarding chain, pinned by source shape -------------------

test("manager /health carries `set`, supervisor forwards it, the relay ANDs it", () => {
  const mgr = fs.readFileSync(MGR, "utf8");
  assert.match(mgr, /"set": _set_active\(\)/, "the manager reports what the box actually serves");
  const sup = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");
  assert.match(sup, /const setc = PROVISION_BACKEND === "vm" && h\.set !== undefined \? \{ set: h\.set === true \} : \{\};/,
    "the supervisor forwards the manager's probed answer, never its own guess");
  assert.match(sup, /\.\.\.cth, \.\.\.setc, /, "and folds it into /availability after coopThreads");
  const relay = fs.readFileSync(path.join(REPO, "relay", "api-relay.js"), "utf8");
  assert.match(relay, /set: serving\.length > 0 && serving\.every\(\(e\) => e\.availability\?\.set === true\)/,
    "the relay must AND it across the claiming fleet, same as every capability");
});

test("the claim gate refuses `set` versions on a box that does not serve SET", () => {
  const sup = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");
  assert.match(sup, /if \(setOfConfig\(g\.config\)\)/, "keyed on the version's declared `set`");
  assert.match(sup, /app uses shared-everything threads and this box's runtime does not serve them/);
  assert.match(sup, /function setOfConfig/, "undeclared/unparseable must mean no-SET (fail-open direction)");
});

test("launch fails a SET guest readably on a box that cannot serve it (not exit 2)", () => {
  const mgr = fs.readFileSync(MGR, "utf8");
  assert.match(mgr, /needs_set = _needs_set_threads\(wasm\)/, "the launch path sniffs the bytes");
  assert.match(mgr, /app uses shared-everything threads \(SET/, "and refuses with words");
  assert.match(mgr, /WASM_SET_THREADS=0 \(operator switch\)/, "naming the operator kill-switch when it is the cause");
});
