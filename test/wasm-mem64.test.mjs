// wasm64 (memory64) support — the >4 GiB guests — held to the same doctrine
// as p3/coop/SET: capability proven by COMPILING the exact construct (never
// help text), refusals in words (never exit 2), classification from the BYTES
// (never metadata), and the wasm32 majority taking byte-identical paths.
//
// Pinned here:
//   1. The structural classifier: a layer-0 module whose memory section
//      carries the 64-bit limits flag is mem64; wasm32 modules and components
//      are not. The runner's copy and the gateway's copy must agree.
//   2. Admission: the gateway and runner admit a mem64 core module where a
//      wasm32 core module keeps the historical refusal.
//   3. Launch gates: serve-mode mem64 refuses with words (port mode only);
//      an engine that cannot compile memory64 refuses with words; the
//      operator switch (WASM_MEM64=0) refuses with its own words.
//   4. The memory ceiling: a mem64 guest's mem_mb is its full RAM slice —
//      the 4 GiB wasm32 clamp lifts for it and ONLY for it.
//
//   run: node --test test/wasm-mem64.test.mjs   (needs python3)
//
// The RUNTIME >4 GiB proof (a 6 GiB malloc+verify+I/O guest on the pinned
// enclave wasmtime 49 binary) is recorded in docs/wasm64.md — it needs the
// real engine and 6 GiB of commit, so it runs at toolchain-verification time,
// not in CI.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");
const GATEWAY = path.join(REPO, "scripts", "ipfs-add-gateway.py");
const FIXTURES = path.join(REPO, "test", "fixtures");

// A minimal synthetic CORE module: real preamble (version 1, layer 0) + a
// memory section (id 5) whose first entry carries the given limits flags.
// 0x00/0x01 = wasm32 (min / min+max), 0x04/0x05 = memory64. This is the
// honest shape — the classifiers parse the section grammar, so a marker
// string in a custom section could never fake it.
function syntheticModule(flags) {
  const limits = flags & 0x01 ? [flags, 1, 2] : [flags, 1];   // min [, max]
  const payload = Buffer.from([1, ...limits]);                 // count=1, limits
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    Buffer.from([5, payload.length]), payload,
  ]);
}

// A minimal synthetic COMPONENT (layer 1) wrapping one core module: the
// component preamble (version 0x0d, layer 1) + a core-module section (id 1)
// whose payload is the whole module binary. This is what a wasm64 wasip2
// app looks like structurally — its main module is a top-level core module
// with a 64-bit memory — and what the classifiers walk into.
function syntheticComponent(coreModule) {
  const size = coreModule.length;
  const uleb = [];
  let n = size;
  do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; uleb.push(b); } while (n);
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]),
    Buffer.from([1, ...uleb]), coreModule,
  ]);
}

// A component holding `inner` as a NESTED component (section id 4) behind a
// wasm32 top-level core module — the shape `wac plug` emits when a wasm64
// app is composed under the wasm32 WASI pass-through proxy.
function composedComponent(inner, frontModule) {
  const uleb = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return Buffer.from(out); };
  const section = (id, body) => Buffer.concat([Buffer.from([id]), uleb(body.length), body]);
  return Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d, 0x0d, 0, 1, 0]), section(1, frontModule), section(4, inner)]);
}

const py = (code, env = {}) => execFileSync("python3", ["-c", code], {
  env: { ...process.env, WASM_MANAGER_PORT: "8091", NODE_HAS_GPU: "0", ...env },
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim().split("\n").pop();

const mgrPy = (expr, env = {}) => JSON.parse(py(`
import importlib.util, sys, json, pathlib
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
print(json.dumps(${expr}))
`, env));

const gwPy = (expr) => JSON.parse(py(`
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("gw", ${JSON.stringify(GATEWAY)})
g = importlib.util.module_from_spec(spec); sys.modules["gw"] = g
spec.loader.exec_module(g)
print(json.dumps(${expr}))
`));

const FAKE = (body) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-m64-"));
  const p = path.join(dir, "wasmtime");
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
};
// compile probes pass; run mode idles long enough for the 2s udp grace
const ENGINE_OK = `case "$1" in run) exec sleep 15;; esac; exit 0`;
// an engine that cannot parse memory64 (or any probe construct)
const ENGINE_NO64 = `case "$1" in compile) exit 1;; esac; exit 0`;

function launchPy(file, { ports = null, env = {} } = {}) {
  const pspec = ports ? `m._parse_ports(${JSON.stringify(ports)})` : "None";
  return JSON.parse(py(`
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
rec = m.launch(${JSON.stringify(file)}, "t", 0.5, pspec=${pspec})
if rec.get("_proc") is not None:
    try: rec["_proc"].terminate()
    except Exception: pass
print(json.dumps({"status": rec["status"], "error": rec.get("error"),
                  "mem64": rec.get("mem64"), "cm64": rec.get("cm64"), "mem_mb": rec.get("mem_mb")}))
`, env));
}

// ---- 1. the structural classifier, in lockstep ------------------------------

test("the memory section's 64-bit flag decides, min-only and min+max alike", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m64fix-"));
  for (const [flags, want] of [[0x00, false], [0x01, false], [0x04, true], [0x05, true]]) {
    const f = path.join(dir, `m${flags}.wasm`);
    writeFileSync(f, syntheticModule(flags));
    assert.equal(
      mgrPy(`m._needs_mem64(pathlib.Path(${JSON.stringify(f)}))`), want,
      `runner: flags 0x${flags.toString(16)}`);
    assert.equal(
      gwPy(`g.module_mem64(open(${JSON.stringify(f)}, "rb").read())`), want,
      `gateway: flags 0x${flags.toString(16)}`);
  }
});

test("components and junk are never mem64 — only a layer-0 memory section counts", () => {
  // a real wasip2 COMPONENT (its nested core memories are its own business)
  const comp = path.join(FIXTURES, "egress-guest-tcp.wasm");
  assert.equal(mgrPy(`m._needs_mem64(pathlib.Path(${JSON.stringify(comp)}))`), false);
  assert.equal(gwPy(`g.module_mem64(open(${JSON.stringify(comp)}, "rb").read())`), false);
  assert.equal(mgrPy(`m._module_mem64(b"junk")`), false);
  assert.equal(gwPy(`g.module_mem64(b"\\x00asm\\x01\\x00\\x00\\x00")`), false, "no memory section");
});

// ---- 2. admission: gateway and runner agree ---------------------------------

test("a mem64 module is admitted where a wasm32 core module keeps the refusal", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m64adm-"));
  const m64 = path.join(dir, "m64.wasm"), m32 = path.join(dir, "m32.wasm");
  writeFileSync(m64, syntheticModule(0x04));
  writeFileSync(m32, syntheticModule(0x00));
  // gateway tier 1
  assert.equal(gwPy(`g.preamble_error(open(${JSON.stringify(m64)}, "rb").read())`), null);
  assert.match(String(gwPy(`g.preamble_error(open(${JSON.stringify(m32)}, "rb").read())`)),
               /core wasm module/);
  // runner's fetch-time check: same split, exception vs pass
  assert.equal(mgrPy(`m._check_component(open(${JSON.stringify(m64)}, "rb").read()) or True`), true);
  assert.throws(
    () => mgrPy(`m._check_component(open(${JSON.stringify(m32)}, "rb").read())`),
    /core wasm module/);
  // the gateway's contract dict stamps mem64 for the publish clients
  const c = gwPy(`g.component_contract(open(${JSON.stringify(m64)}, "rb").read())`);
  assert.equal(c.mem64, true);
  assert.equal(c.wasi, null, "a p1 core module has no component world");
});

// ---- 3. launch gates: words, never exit 2 -----------------------------------

test("a port-declaring mem64 app fails at launch with the compute-guest words", () => {
  // preview1 has no socket surface on the engine — declared ports would wait
  // for a bind that can never come, so the refusal happens up front
  const dir = mkdtempSync(path.join(tmpdir(), "m64prt-"));
  const f = path.join(dir, "m64.wasm");
  writeFileSync(f, syntheticModule(0x04));
  const rec = launchPy(f, { ports: ["tcp:9000"],
    env: { WASMTIME_BIN: FAKE(ENGINE_OK), WASM_APPS_DIR: dir, WASM_FS: "0" } });
  assert.equal(rec.status, "failed");
  assert.match(rec.error, /compute guests/);
});

test("an engine that cannot compile memory64 refuses mem64 guests readably", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m64no-"));
  const f = path.join(dir, "m64.wasm");
  writeFileSync(f, syntheticModule(0x04));
  const rec = launchPy(f, {
    env: { WASMTIME_BIN: FAKE(ENGINE_NO64), WASM_APPS_DIR: dir, WASM_FS: "0" } });
  assert.equal(rec.status, "failed");
  assert.match(rec.error, /mem64-capable enclave must claim it/);
});

test("WASM_MEM64=0 is an operator kill-switch with its own words", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m64off-"));
  const f = path.join(dir, "m64.wasm");
  writeFileSync(f, syntheticModule(0x04));
  const rec = launchPy(f, {
    env: { WASMTIME_BIN: FAKE(ENGINE_OK), WASM_APPS_DIR: dir, WASM_FS: "0", WASM_MEM64: "0" } });
  assert.equal(rec.status, "failed");
  assert.match(rec.error, /WASM_MEM64=0 \(operator switch\)/);
});

test("the mem64 launch shape grants no socket surface and no component flags", () => {
  const pspec = `{"serve": True, "http": None, "tcp": [], "udp": [], "declared": [], "norm": []}`;
  const [cmd, hostPort, wait] = mgrPy(
    `m._build_cmd(${pspec}, "/tmp/app.wasm", 0, 1024 * 1024, None, None, mem64=True)`,
    { WASMTIME_BIN: FAKE(ENGINE_OK) });
  assert.equal(cmd[1], "run", "wasmtime run, never serve");
  for (const flag of ["-Stcp", "-Sudp", "-Sinherit-network", "-Sallow-ip-name-lookup", "-Sp3"])
    assert.ok(!cmd.includes(flag), `${flag} must not be granted — preview1 cannot reach it`);
  assert.ok(cmd.includes("max-memory-size=1048576"), "the ceiling rides the cmd");
  assert.equal(hostPort, 0);
  assert.deepEqual(wait, [], "udp-style readiness: no waitable port");
});

// ---- 4. the memory ceiling + the compute-guest launch shape -----------------

test("a portless mem64 guest RUNS as a compute guest with its full RAM slice; a component keeps the 4 GiB clamp", () => {
  // cpuShare 0.5 of the default 64 GB node = 32768 MB — past the wasm32 clamp
  const dir = mkdtempSync(path.join(tmpdir(), "m64mem-"));
  const f = path.join(dir, "m64.wasm");
  writeFileSync(f, syntheticModule(0x04));
  const env = { WASMTIME_BIN: FAKE(ENGINE_OK), WASM_APPS_DIR: dir, WASM_FS: "0" };
  const m64 = launchPy(f, { env });
  assert.equal(m64.mem64, true);
  assert.equal(m64.status, "running", m64.error || "");
  assert.equal(m64.mem_mb, 32768, "the clamp lifts to the deployment's slice");
  // the wasm32 control: a real component through the same launch keeps 4096
  // (copied into the apps dir — _resolve_wasm only serves paths under it)
  const compPath = path.join(dir, "comp.wasm");
  copyFileSync(path.join(FIXTURES, "egress-guest-tcp.wasm"), compPath);
  const comp = launchPy(compPath, { ports: ["udp:9000"], env });
  assert.equal(comp.mem64, false);
  assert.equal(comp.mem_mb, 4096, "wasm32 guests keep the historical ceiling");
});

// ---- 5. memory64 COMPONENTS: the run-mode shape wasm64 ships in ------------
//
// A wasip2 app built for wasm64 is a component whose main core module has a
// 64-bit memory. It is NOT a compute guest: it keeps ports and sockets, and
// the only launch differences are the engine's memory64 switches and the
// ceiling lift. Every classifier must see it, in lockstep, and never confuse
// it with the portless core-module class.

test("a memory64 component is mem64 for every classifier; a wasm32 one is not", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cm64cls-"));
  const c64 = path.join(dir, "c64.wasm"), c32 = path.join(dir, "c32.wasm");
  writeFileSync(c64, syntheticComponent(syntheticModule(0x04)));
  writeFileSync(c32, syntheticComponent(syntheticModule(0x00)));
  assert.equal(mgrPy(`m._needs_cm64(pathlib.Path(${JSON.stringify(c64)}))`), true);
  assert.equal(mgrPy(`m._needs_cm64(pathlib.Path(${JSON.stringify(c32)}))`), false);
  // the core-module classifier must NOT fire on a component
  assert.equal(mgrPy(`m._needs_mem64(pathlib.Path(${JSON.stringify(c64)}))`), false);
  assert.equal(gwPy(`g.component_mem64(open(${JSON.stringify(c64)}, "rb").read())`), true);
  assert.equal(gwPy(`g.component_mem64(open(${JSON.stringify(c32)}, "rb").read())`), false);
  // the gateway's contract dict stamps mem64 for the publish clients
  const c = gwPy(`g.component_contract(open(${JSON.stringify(c64)}, "rb").read())`);
  assert.equal(c.mem64, true);
  // the CLI's copy agrees
  const cli = readFileSync(path.join(REPO, "cli", "enclave.mjs"), "utf8");
  const fn = cli.slice(cli.indexOf("function moduleMem64("), cli.indexOf("function componentContract("));
  const f = new Function("Buffer", fn + "; return { moduleMem64, componentMem64 };")(Buffer);
  assert.equal(f.componentMem64(readFileSync(c64)), true);
  assert.equal(f.componentMem64(readFileSync(c32)), false);
  assert.equal(f.moduleMem64(readFileSync(c64)), false, "the module classifier stays layer-0 only");
});

test("a memory64 component launches like any component, plus the engine switches and the ceiling lift", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cm64run-"));
  const f = path.join(dir, "c64.wasm");
  writeFileSync(f, syntheticComponent(syntheticModule(0x04)));
  // port mode with a declared port: NOT the compute-guest refusal (udp-only
  // is the waitable-port-free shape the fake engine can satisfy, as in the
  // wasm32 control above); cpuShare 0.5 of the default 64 GB node = 32768 MB
  const rec = launchPy(f, { ports: ["udp:9000"],
    env: { WASMTIME_BIN: FAKE(ENGINE_OK), WASM_APPS_DIR: dir, WASM_FS: "0" } });
  assert.equal(rec.status, "running", rec.error || "");
  assert.equal(rec.mem64, true);
  assert.equal(rec.cm64, true);
  assert.equal(rec.mem_mb, 32768, "the clamp lifts to the deployment's slice for a memory64 component");
  // the command carries the memory64 switches (a plain component's would not)
  const cmd = mgrPy(`" ".join(m._build_cmd(m._parse_ports(["tcp:9000"]), ${JSON.stringify(f)}, 0, 1 << 30, {"tcp:9000": 31000}, cm64=True)[0])`,
    { WASMTIME_BIN: FAKE(ENGINE_OK) });
  assert.match(cmd, /-W memory64,component-model-memory64/);
  const plain = mgrPy(`" ".join(m._build_cmd(m._parse_ports(["tcp:9000"]), ${JSON.stringify(f)}, 0, 1 << 30, {"tcp:9000": 31000})[0])`,
    { WASMTIME_BIN: FAKE(ENGINE_OK) });
  assert.doesNotMatch(plain, /component-model-memory64/);
});

test("an engine that cannot compile the memory64 COMPONENT probe refuses readably", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cm64no-"));
  const f = path.join(dir, "c64.wasm");
  writeFileSync(f, syntheticComponent(syntheticModule(0x04)));
  // compile succeeds for the core-module probe but fails under the cm64 flags
  const ENGINE_NO_CM64 = `case "$1" in compile) case "$*" in *component-model-memory64*) exit 1;; esac; exit 0;; run) exec sleep 15;; esac; exit 0`;
  const rec = launchPy(f, { ports: ["tcp:9000"],
    env: { WASMTIME_BIN: FAKE(ENGINE_NO_CM64), WASM_APPS_DIR: dir, WASM_FS: "0" } });
  assert.equal(rec.status, "failed");
  assert.match(rec.error, /component-model-memory64/);
});

test("a memory64 core nested in a composed component (wasm32 proxy in front) is mem64 for every classifier", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cm64nest-"));
  const c = path.join(dir, "composed.wasm"), c32 = path.join(dir, "composed32.wasm");
  writeFileSync(c, composedComponent(syntheticComponent(syntheticModule(0x04)), syntheticModule(0x00)));
  writeFileSync(c32, composedComponent(syntheticComponent(syntheticModule(0x00)), syntheticModule(0x00)));
  assert.equal(mgrPy(`m._needs_cm64(pathlib.Path(${JSON.stringify(c)}))`), true, "the nested 64-bit core decides, not the 32-bit front module");
  assert.equal(mgrPy(`m._needs_cm64(pathlib.Path(${JSON.stringify(c32)}))`), false);
  assert.equal(gwPy(`g.component_mem64(open(${JSON.stringify(c)}, "rb").read())`), true);
  assert.equal(gwPy(`g.component_mem64(open(${JSON.stringify(c32)}, "rb").read())`), false);
  assert.equal(gwPy(`g.component_contract(open(${JSON.stringify(c)}, "rb").read())`).mem64, true);
  // the CLI's copy descends too
  const cli = readFileSync(path.join(REPO, "cli", "enclave.mjs"), "utf8");
  const cfn = cli.slice(cli.indexOf("function moduleMem64("), cli.indexOf("function componentContract("));
  const cf = new Function("Buffer", cfn + "; return { moduleMem64, componentMem64 };")(Buffer);
  assert.equal(cf.componentMem64(readFileSync(c)), true);
  assert.equal(cf.componentMem64(readFileSync(c32)), false);
  // and the site's (plain Uint8Array input, no Buffer)
  const site = readFileSync(path.join(REPO, "site", "js", "pages", "apps.js"), "utf8");
  const s0 = site.indexOf("function moduleMem64("), s1 = site.indexOf("function componentMem64(");
  const sEnd = site.indexOf("\n}\n", s1) + 3;
  const sf = new Function(site.slice(s0, sEnd) + "; return { moduleMem64, componentMem64 };")();
  assert.equal(sf.componentMem64(new Uint8Array(readFileSync(c))), true);
  assert.equal(sf.componentMem64(new Uint8Array(readFileSync(c32))), false);
});
