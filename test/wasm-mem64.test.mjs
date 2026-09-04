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
//   5. ONE >4 GiB class: a memory64 COMPONENT, which keeps its ports. The
//      publish door (gateway + both clients) refuses every core module,
//      wasm64 or not, and the advertised capability means "can run a
//      memory64 component" — both engine probes, not just one.
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
    // the module sniff is the primitive every classifier is built on. It is
    // applied to a COMPONENT's inner core modules now, never to a published
    // artifact of its own: core modules are refused at the door.
    assert.equal(
      mgrPy(`m._module_mem64(open(${JSON.stringify(f)}, "rb").read())`), want,
      `runner: flags 0x${flags.toString(16)}`);
    assert.equal(
      gwPy(`g.module_mem64(open(${JSON.stringify(f)}, "rb").read())`), want,
      `gateway: flags 0x${flags.toString(16)}`);
    // and the component classifier says the same of a component wrapping it
    const c = path.join(dir, `c${flags}.wasm`);
    writeFileSync(c, syntheticComponent(syntheticModule(flags)));
    assert.equal(mgrPy(`m._needs_cm64(pathlib.Path(${JSON.stringify(c)}))`), want,
      `runner, wrapped: flags 0x${flags.toString(16)}`);
  }
});

test("the MODULE sniff is layer-0 only: components and junk are never mem64 by it", () => {
  // a real wasip2 COMPONENT — its nested core memories are the component
  // classifier's business, not this one's
  const comp = path.join(FIXTURES, "egress-guest-tcp.wasm");
  assert.equal(mgrPy(`m._module_mem64(open(${JSON.stringify(comp)}, "rb").read())`), false);
  assert.equal(gwPy(`g.module_mem64(open(${JSON.stringify(comp)}, "rb").read())`), false);
  assert.equal(mgrPy(`m._module_mem64(b"junk")`), false);
  assert.equal(gwPy(`g.module_mem64(b"\\x00asm\\x01\\x00\\x00\\x00")`), false, "no memory section");
});

// ---- 2. admission: gateway and runner agree ---------------------------------

test("components only at the door: a core module is refused whether or not it is mem64", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m64adm-"));
  const m64 = path.join(dir, "m64.wasm"), m32 = path.join(dir, "m32.wasm");
  const c64 = path.join(dir, "c64.wasm");
  writeFileSync(m64, syntheticModule(0x04));
  writeFileSync(m32, syntheticModule(0x00));
  writeFileSync(c64, syntheticComponent(syntheticModule(0x04)));
  // gateway tier 1: the wasm64 carve-out is gone, so both core modules are
  // refused, and the mem64 one is pointed at the component build image
  const err64 = String(gwPy(`g.preamble_error(open(${JSON.stringify(m64)}, "rb").read())`));
  assert.match(err64, /core wasm module/);
  assert.match(err64, /wasm64p2/, "the refusal names the way to build a >4 GiB guest");
  assert.match(String(gwPy(`g.preamble_error(open(${JSON.stringify(m32)}, "rb").read())`)),
               /core wasm module/);
  assert.equal(gwPy(`g.preamble_error(open(${JSON.stringify(c64)}, "rb").read())`), null,
               "a memory64 COMPONENT is the >4 GiB class and passes");
  // the runner's fetch-time check agrees: no core module runs here, mem64 or
  // not (the catalog was audited clear of the old class before this landed)
  for (const mod of [m64, m32])
    assert.throws(() => mgrPy(`m._check_component(open(${JSON.stringify(mod)}, "rb").read())`),
                  /core wasm module/);
  // the gateway's contract dict stamps mem64 from the component
  const c = gwPy(`g.component_contract(open(${JSON.stringify(c64)}, "rb").read())`);
  assert.equal(c.mem64, true);
});

// ---- 3. launch gates: words, never exit 2 -----------------------------------

test("an engine that cannot compile memory64 refuses mem64 guests readably", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m64no-"));
  const f = path.join(dir, "c64.wasm");
  writeFileSync(f, syntheticComponent(syntheticModule(0x04)));
  const rec = launchPy(f, { ports: ["udp:9000"],
    env: { WASMTIME_BIN: FAKE(ENGINE_NO64), WASM_APPS_DIR: dir, WASM_FS: "0" } });
  assert.equal(rec.status, "failed");
  assert.match(rec.error, /mem64-capable enclave must claim it/);
});

test("WASM_MEM64=0 is an operator kill-switch with its own words", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m64off-"));
  const f = path.join(dir, "c64.wasm");
  writeFileSync(f, syntheticComponent(syntheticModule(0x04)));
  const rec = launchPy(f, { ports: ["udp:9000"],
    env: { WASMTIME_BIN: FAKE(ENGINE_OK), WASM_APPS_DIR: dir, WASM_FS: "0", WASM_MEM64: "0" } });
  assert.equal(rec.status, "failed");
  assert.match(rec.error, /WASM_MEM64=0 \(operator switch\)/);
});

// ---- 4. no compute-guest shape survives ------------------------------------

test("the portless compute-guest launch shape is gone, parameter and all", () => {
  // the old wasm64 class had its own arm in _build_cmd: `wasmtime run` with
  // no listener and no socket grants, because preview1 could not serve one.
  // A memory64 component is served like any other component, so the arm and
  // its keyword are gone — passing it must be an error, not a silent mode.
  const pspec = `{"serve": True, "http": None, "tcp": [], "udp": [], "declared": [], "norm": []}`;
  assert.throws(
    () => mgrPy(`m._build_cmd(${pspec}, "/tmp/app.wasm", 0, 1048576, None, None, mem64=True)`,
                { WASMTIME_BIN: FAKE(ENGINE_OK) }),
    /mem64/,
    "the compute-guest arm must not survive as an accepted keyword");
});

// ---- 4b. the guest is TOLD its ceiling --------------------------------------
//
// `-W max-memory-size` is enforced by the engine and invisible from inside:
// a guest can only discover it by hitting it, which for a big allocation
// means dying rather than adapting. ENCLAVE_MEM_MB hands it over, so an app
// can size a heap, a cache or an emulated machine's RAM to the share the
// deployer actually bought — the memory twin of ENCLAVE_AVAILABLE_PARALLELISM.

test("every guest is handed its own memory ceiling, on the flag the guest can actually see", () => {
  // The FIRST version of this test read the environment the wasmtime PROCESS
  // was launched with, and passed while the guest saw nothing: a guest
  // inherits none of that (there is no -Sinherit-env). Only an explicit
  // --env reaches it, which is what this asserts, and what a real deployment
  // proved by logging "no ENCLAVE_MEM_MB from the host".
  const memEnv = (cmd) => {
    const i = cmd.findIndex((a) => typeof a === "string" && a.startsWith("ENCLAVE_MEM_MB="));
    assert.ok(i > 0 && cmd[i - 1] === "--env", `ENCLAVE_MEM_MB must ride as a --env flag: ${cmd.join(" ")}`);
    return Number(cmd[i].split("=")[1]);
  };
  const pspec = `{"serve": True, "http": None, "tcp": [], "udp": [{"guest": 9000, "host": 9000}], "declared": ["udp:9000"], "norm": ["udp:9000"]}`;
  const [cmd] = mgrPy(`m._build_cmd(${pspec}, "/tmp/app.wasm", 0, 4096 * 1024 * 1024)`,
                      { WASMTIME_BIN: FAKE(ENGINE_OK) });
  assert.equal(memEnv(cmd), 4096, "MiB, and the same number -W max-memory-size gets");
  assert.ok(cmd.includes("max-memory-size=4294967296"), "the engine cap and the hint are one number");
  // the mem64 arm: a lifted ceiling is what the guest is told
  const [big] = mgrPy(`m._build_cmd(${pspec}, "/tmp/app.wasm", 0, 32768 * 1024 * 1024, cm64=True)`,
                      { WASMTIME_BIN: FAKE(ENGINE_OK) });
  assert.equal(memEnv(big), 32768, "a mem64 guest is told about the lift");
  // and it survives the whole launch, on the real command the engine gets
  const dir = mkdtempSync(path.join(tmpdir(), "memenv-"));
  const c32 = path.join(dir, "c32.wasm");
  copyFileSync(path.join(FIXTURES, "egress-guest-tcp.wasm"), c32);
  const argvFile = path.join(dir, "argv.txt");
  const ENGINE_ARGV = `case "$1" in run) printf '%s\\n' "$@" > ${argvFile}; exec sleep 15;; esac; exit 0`;
  const rec = launchPy(c32, { ports: ["udp:9000"],
    env: { WASMTIME_BIN: FAKE(ENGINE_ARGV), WASM_APPS_DIR: dir, WASM_FS: "0" } });
  assert.equal(rec.status, "running", rec.error || "");
  const argv = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
  assert.equal(memEnv(argv), rec.mem_mb, "the launched guest is told exactly what the record says");
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
  // the MODULE sniff must not fire on a component's own bytes
  assert.equal(mgrPy(`m._module_mem64(open(${JSON.stringify(c64)}, "rb").read())`), false);
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

test("the advertised mem64 capability requires BOTH probes: a box that cannot run a memory64 COMPONENT does not claim to serve >4 GiB", () => {
  // the >4 GiB guest class IS a memory64 component, so a box that proved only
  // plain memory64 would win a claim it cannot launch and queue the
  // deployment on the wrong host. /health's `mem64` is the AND.
  const ENGINE_NO_CM64 = `case "$1" in compile) case "$*" in *component-model-memory64*) exit 1;; esac; exit 0;; run) exec sleep 15;; esac; exit 0`;
  const ENGINE_NO_MEM64 = `case "$1" in compile) exit 1;; run) exec sleep 15;; esac; exit 0`;
  const advertised = (engine, env = {}) =>
    mgrPy("m._mem64_advertised()", { WASMTIME_BIN: FAKE(engine), ...env });
  assert.equal(advertised(ENGINE_OK), true, "an engine that compiles both probes serves the class");
  assert.equal(advertised(ENGINE_NO_CM64), false, "component-model memory64 missing: do not advertise");
  assert.equal(advertised(ENGINE_NO_MEM64), false, "memory64 missing: do not advertise");
  // the operator switch still overrides a fully capable engine
  assert.equal(advertised(ENGINE_OK, { WASM_MEM64: "0" }), false, "WASM_MEM64=0 wins");
  // and the launch-time helper stays SEPARATE: it must not fold cm64 in, or
  // the two refusals (plain memory64 vs component memory64) collapse into one
  assert.equal(mgrPy("m._mem64_active()", { WASMTIME_BIN: FAKE(ENGINE_NO_CM64) }), true,
    "_mem64_active is the plain-memory64 answer; the component probe is the advertisement's job");
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

// ---- 6. the two classes, in the publish clients -------------------------
//
// `mem64` is one routing key over two classes. Conflating them cost a real
// publish: a memory64 COMPONENT with ports was refused with "ports can never
// be served from a preview1 module", which is true of a core module and false
// of a component. The runner has always split them (_needs_mem64 vs
// _needs_cm64); the CLI and the site now do too, through mem64Class.

// The site's own validateWasm, extracted and run against real File objects.
// Its only free names are the error class and the size ceiling.
function siteValidateWasm() {
  const site = readFileSync(path.join(REPO, "site", "js", "pages", "apps.js"), "utf8");
  const i = site.indexOf("async function validateWasm(");
  const src = site.slice(i, site.indexOf("\n}\n", i) + 3);
  return new Function("EnclaveError", "MAX_WASM_BYTES", "MAX_WASM_MB",
    src + "; return validateWasm;")(
      class extends Error {}, 100 * 1048576, 100);
}

test("both publish clients refuse a core module outright and take a memory64 component", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m64pub-"));
  const comp = path.join(dir, "c64.wasm"), mod = path.join(dir, "m64.wasm");
  writeFileSync(comp, syntheticComponent(syntheticModule(0x04)));
  writeFileSync(mod, syntheticModule(0x04));

  // the site, before it ever uploads
  const validate = siteValidateWasm();
  assert.equal(await validate(new File([readFileSync(comp)], "c64.wasm")), true);
  await assert.rejects(() => validate(new File([readFileSync(mod)], "m64.wasm")),
    /core wasm module/, "a wasm64 core module no longer slips through as a compute guest");

  // the CLI, through the real publish path: cmdPublish classifies and applies
  // this rule before it touches a wallet or an RPC
  const CLI = path.join(REPO, "cli", "enclave.mjs");
  const publish = (wasm) => {
    try {
      execFileSync(process.execPath, [CLI, "publish", wasm, "--slug", "m64test",
        "--ports", "tcp:9000", "--version", "0.0.1", "--yes"],
        { encoding: "utf8", stdio: "pipe", timeout: 60000, env: { ...process.env, ENCLAVE_KEY: "" } });
      return "";
    } catch (e) { return `${e.stdout || ""}${e.stderr || ""}${e.message || ""}`; }
  };
  assert.match(publish(mod), /core wasm module/, "a wasm64 core module is refused at publish");
  // and a memory64 component with ports is ordinary: no compute-guest words,
  // no port rule, it fails later on the missing key like any other publish
  const compOut = publish(comp);
  assert.doesNotMatch(compOut, /compute guest/, `got: ${compOut.slice(0, 300)}`);
  assert.doesNotMatch(compOut, /core wasm module/, `got: ${compOut.slice(0, 300)}`);
});
