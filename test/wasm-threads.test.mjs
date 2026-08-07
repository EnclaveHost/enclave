// Cooperative threads (wasip3 🧵), held to the p3/loopback doctrine — with the
// new lesson this capability taught: HELP TEXT IS A LIAR. wasmtime 47
// advertises `-W component-model-threading` yet cannot parse the
// `thread.new-indirect` canon builtin every coop guest is linked around, so
// the probe COMPILES a probe component instead of grepping help, and only a
// compile that succeeds counts as capability.
//
// Surfaces pinned here:
//   1. `-W component-model-threading` is emitted only for a tenant whose
//      bytes need it (the `[thread-` sniff), only when the compile probe
//      passed, only under p3, and never under WASM_COOP_THREADS=0.
//   2. The sniff itself: coop-linked bytes carry `[thread-` verbatim;
//      non-coop bytes must not trip it.
//   3. Lockstep: the gateway's Python classifier reports the same `threads`
//      answer the runner's sniff gives for the same bytes.
//
//   run: node --test test/wasm-threads.test.mjs   (needs python3)

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");
const GATEWAY = path.join(REPO, "scripts", "ipfs-add-gateway.py");

const FAKE = (body) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-threads-"));
  const p = path.join(dir, "wasmtime");
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
};

// A p3-capable help surface (the threads flag only ever rides along with p3).
const HELP = `echo "  -S    loopback-allow=<port[+port...]> -- ..."; echo "  -S            p3[=y|n] -- Enable support for WASIp3 APIs."; echo "  -W  component-model-async[=y|n] -- ..."; echo "  -W  component-model-threading[=y|n] -- ..."; exit 0`;
// compile probe passes: the engine really runs coop guests
const BIN_THREADS_OK = `if [ "$1" = "compile" ]; then exit 0; fi; ${HELP}`;
// the wasmtime-47 shape: help ADVERTISES the option, compile chokes on the
// builtin. Advertising must count for nothing.
const BIN_HELP_LIAR = `if [ "$1" = "compile" ]; then echo "failed to parse WebAssembly module" >&2; exit 1; fi; ${HELP}`;

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
print(json.dumps({"cmd": cmd, "supported": m._threads_supported(), "active": m._threads_active()}))
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, WASM_MANAGER_PORT: "8091", NODE_HAS_GPU: "0", ...env },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

// ---- 1. the flag ------------------------------------------------------------

test("a proven engine + a thread-needing tenant = the flag, in both modes", () => {
  const bin = FAKE(BIN_THREADS_OK);
  for (const serve of [true, false]) {
    const { cmd, supported, active } = probe({ threads: true }, { serve, env: { WASMTIME_BIN: bin } });
    assert.equal(supported, true);
    assert.equal(active, true);
    const i = cmd.indexOf("component-model-threading");
    assert.ok(i > 0 && cmd[i - 1] === "-W",
      `${serve ? "serve" : "run"} argv must carry -W component-model-threading for a threaded tenant`);
  }
});

test("a tenant WITHOUT the marker never gets the flag, even on a capable box", () => {
  // per-tenant, not blanket: the 🧵 surface is experimental engine area
  const bin = FAKE(BIN_THREADS_OK);
  const { cmd, active } = probe({ threads: false }, { env: { WASMTIME_BIN: bin } });
  assert.equal(active, true, "the box is capable");
  assert.ok(!cmd.includes("component-model-threading"), "but a non-threaded tenant does not carry the flag");
});

test("help text is a liar: advertising the option without compiling the builtin is NOT capability", () => {
  // the wasmtime-47 shape. A box like this must refuse threaded claims, not
  // die in "failed to parse WebAssembly module" per tenant.
  const bin = FAKE(BIN_HELP_LIAR);
  const { cmd, supported, active } = probe({ threads: true }, { env: { WASMTIME_BIN: bin } });
  assert.equal(supported, false);
  assert.equal(active, false);
  assert.ok(!cmd.includes("component-model-threading"));
});

test("an unanswerable probe drops the flag, not the box", () => {
  const missing = path.join(tmpdir(), "no-such-wasmtime-" + process.pid);
  const { cmd, supported } = probe({ threads: true }, { env: { WASMTIME_BIN: missing } });
  assert.equal(supported, false);
  assert.ok(!cmd.includes("component-model-threading"));
});

test("WASM_COOP_THREADS=0 is an operator kill-switch over a capable engine", () => {
  const bin = FAKE(BIN_THREADS_OK);
  const { cmd, supported, active } = probe({ threads: true }, { env: { WASMTIME_BIN: bin, WASM_COOP_THREADS: "0" } });
  assert.equal(supported, true, "the engine still compiles the builtin");
  assert.equal(active, false, "but the box does not serve threads");
  assert.ok(!cmd.includes("component-model-threading"));
});

test("threads ride on p3: a box not serving p3 does not serve threads either", () => {
  const bin = FAKE(BIN_THREADS_OK);
  const { cmd, active } = probe({ threads: true }, { env: { WASMTIME_BIN: bin, WASM_P3: "0" } });
  assert.equal(active, false);
  assert.ok(!cmd.includes("component-model-threading"));
});

// ---- 2. the sniff -----------------------------------------------------------

function sniff(bytesJs) {
  const code = `
import importlib.util, sys, json, pathlib, tempfile, os
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
d = tempfile.mkdtemp()
p = pathlib.Path(d) / "probe.wasm"
p.write_bytes(bytes(${bytesJs}))
print(json.dumps(m._needs_coop_threads(p)))
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, WASM_MANAGER_PORT: "8091", NODE_HAS_GPU: "0" },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("the [thread- marker trips the sniff; its absence does not", () => {
  assert.equal(sniff(`b"\\x00asm\\x0d\\x00\\x01\\x00 [thread-new-indirect-v0] rest"`), true);
  assert.equal(sniff(`b"\\x00asm\\x0d\\x00\\x01\\x00 no threads here"`), false);
});

// ---- 3. gateway lockstep ----------------------------------------------------

test("the gateway's Python classifier reports the same `threads` answer", () => {
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("gw", ${JSON.stringify(GATEWAY)})
g = importlib.util.module_from_spec(spec); sys.modules["gw"] = g
spec.loader.exec_module(g)
threaded = b"\\x00asm\\x0d\\x00\\x01\\x00 [thread-new-indirect-v0]"
plain = b"\\x00asm\\x0d\\x00\\x01\\x00 nothing"
print(json.dumps([g.component_contract(threaded)["threads"], g.component_contract(plain)["threads"]]))
`;
  const out = execFileSync("python3", ["-c", code], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.deepEqual(JSON.parse(out.trim().split("\n").pop()), [true, false]);
});
