// WASIp3 support, held to the same doctrine the loopback wall earned the hard
// way: the launcher never passes an option this wasmtime does not have, and a
// component's world contract is read from its BYTES, never believed from
// metadata.
//
// Three surfaces are pinned here:
//   1. `-Sp3` is emitted only on positive evidence from the binary's own
//      `-S help` ("p3[=y|n]"), suppressed by WASM_P3=0, and dropped when the
//      probe cannot answer — dropping costs nothing on the p2 majority, while
//      passing it to a binary that rejects it is the 2026-07-28 exit-2 outage
//      on EVERY tenant.
//   2. The world classifier: the export section decides, in the order
//      `wasmtime serve` tries instantiation; real wasip2 fixtures and a
//      synthetic p3 component must classify, and the gateway's Python copy
//      must agree with the runner's (they are deliberate lockstep twins).
//   3. The capability plumbing: manager /health -> supervisor /availability
//      -> relay fleet-AND, same shape as proofOfTime.
//
//   run: node --test test/wasm-p3.test.mjs   (needs python3)

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MGR = path.join(REPO, "wasm", "wasm_manager.py");
const GATEWAY = path.join(REPO, "scripts", "ipfs-add-gateway.py");
const FIXTURES = path.join(REPO, "test", "fixtures");

const FAKE = (body) => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-p3-"));
  const p = path.join(dir, "wasmtime");
  writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return p;
};

// help output shapes: the loopback line keeps those tests' invariants intact
const HELP_P3 = `echo "  -S    loopback-allow=<port[+port...]> -- ..."; echo "  -S            p3[=y|n] -- Enable support for WASIp3 APIs."; exit 0`;
const HELP_NO_P3 = `echo "  -S    loopback-allow=<port[+port...]> -- ..."; exit 0`;
// long-option help for the serve tuning knobs (same fake answers both probes)
const HELP_P3_TUNING = HELP_P3.replace("exit 0",
  `echo "      --max-instance-reuse-count <N>"; echo "      --max-instance-concurrent-reuse-count <N>"; echo "      --idle-instance-timeout <T>"; exit 0`);

function cmdFor(kw = {}, { serve = true, env = {} } = {}) {
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
pspec = ${serve
    ? '{"serve": True, "http": None, "tcp": [], "udp": [], "declared": [], "norm": []}'
    : '{"serve": False, "http": 8080, "tcp": [8080], "udp": [], "declared": ["tcp:8080"], "norm": ["http:8080"]}'}
cmd, host_port, wait = m._build_cmd(pspec, "/tmp/app.wasm", 20001, 64 * 1024 * 1024,
                                    ${serve ? "None" : '{"http:8080": 20002}'}, None, **${JSON.stringify(kw)})
print(json.dumps({"cmd": cmd, "p3": m._p3_supported(), "active": m._p3_active()}))
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, WASM_MANAGER_PORT: "8091", NODE_HAS_GPU: "0", ...env },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

// ---- 1. the -Sp3 probe ------------------------------------------------------

test("a wasmtime that proves p3 gets -Sp3, in both launch modes", () => {
  const bin = FAKE(HELP_P3);
  for (const serve of [true, false]) {
    const { cmd } = cmdFor({}, { serve, env: { WASMTIME_BIN: bin } });
    assert.ok(cmd.includes("-Sp3"), `${serve ? "serve" : "run"} argv must carry -Sp3`);
  }
});

test("a wasmtime WITHOUT p3 is never handed the flag", () => {
  const bin = FAKE(HELP_NO_P3);
  for (const serve of [true, false]) {
    const { cmd, p3 } = cmdFor({}, { serve, env: { WASMTIME_BIN: bin } });
    assert.equal(p3, false);
    assert.ok(!cmd.includes("-Sp3"), "an unknown -S option is exit 2 before the module is read");
  }
});

test("an unanswerable probe drops the flag, not the box", () => {
  // Same inversion the loopback probe settled on: unproven means DO NOT PASS.
  // Here it is even easier — dropping -Sp3 leaves every wasip2 tenant exactly
  // as it was, and wasip3 versions are refused at claim/launch with words.
  const missing = path.join(tmpdir(), "no-such-wasmtime-" + process.pid);
  const { cmd } = cmdFor({}, { env: { WASMTIME_BIN: missing } });
  assert.ok(!cmd.includes("-Sp3"));
});

test("WASM_P3=0 is an operator kill-switch over a capable binary", () => {
  const bin = FAKE(HELP_P3);
  const { cmd, p3, active } = cmdFor({}, { env: { WASMTIME_BIN: bin, WASM_P3: "0" } });
  assert.equal(p3, true, "the binary still speaks it");
  assert.equal(active, false, "but the box does not serve it");
  assert.ok(!cmd.includes("-Sp3"));
});

// ---- 2. the p3 serve tuning knobs ------------------------------------------

test("a wasip3 component's `p3` config knobs land as serve flags, clamped", () => {
  const bin = FAKE(HELP_P3_TUNING);
  const cfg = JSON.stringify({ p3: { maxConcurrent: 4, maxReuse: 99999, idleSeconds: 5 } });
  const { cmd } = cmdFor({ enclave_config: cfg, wasi_contract: "0.3" }, { env: { WASMTIME_BIN: bin } });
  const val = (flag) => cmd[cmd.indexOf(flag) + 1];
  assert.equal(val("--max-instance-concurrent-reuse-count"), "4");
  assert.equal(val("--max-instance-reuse-count"), "1024", "clamped to the ceiling");
  assert.equal(val("--idle-instance-timeout"), "5s");
});

test("the knobs never reach a p2 component or an older serve", () => {
  const cfg = JSON.stringify({ p3: { maxConcurrent: 4 } });
  // p2-classified component: wasmtime's own defaults stand
  const p2 = cmdFor({ enclave_config: cfg, wasi_contract: "0.2" }, { env: { WASMTIME_BIN: FAKE(HELP_P3_TUNING) } });
  assert.ok(!p2.cmd.includes("--max-instance-concurrent-reuse-count"));
  // a serve whose --help lacks the long options: degrade to defaults, loudly —
  // these flags are younger than -Sp3 itself and must never exit-2 a tenant
  const old = cmdFor({ enclave_config: cfg, wasi_contract: "0.3" }, { env: { WASMTIME_BIN: FAKE(HELP_P3) } });
  assert.ok(!old.cmd.includes("--max-instance-concurrent-reuse-count"));
});

test("junk knob values degrade to wasmtime's defaults, never brick the version", () => {
  const bin = FAKE(HELP_P3_TUNING);
  const cfg = JSON.stringify({ p3: { maxConcurrent: "many", idleSeconds: 2 } });
  const { cmd } = cmdFor({ enclave_config: cfg, wasi_contract: "0.3" }, { env: { WASMTIME_BIN: bin } });
  assert.ok(!cmd.includes("--max-instance-concurrent-reuse-count"), "the bad key is dropped");
  assert.equal(cmd[cmd.indexOf("--idle-instance-timeout") + 1], "2s", "the good key still lands");
});

// ---- 3. the world classifier ------------------------------------------------

// A minimal synthetic component: real preamble (version 0x0d, layer 1) + one
// top-level export section (id 11) whose payload carries a length-prefixed
// export name, the way real components encode it. The classifier only trusts
// names it finds inside section 10/11 payloads, so this is the honest shape.
function syntheticComponent(exportName, { layer = 1, extraSectionName = null } = {}) {
  const name = Buffer.from(exportName, "latin1");
  assert.ok(name.length < 128, "single-byte LEB for the test");
  const payload = Buffer.concat([Buffer.from([1, name.length]), name, Buffer.from([0, 0, 0])]);
  const section = Buffer.concat([Buffer.from([11, payload.length]), payload]);
  const parts = [Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, layer, 0x00]), section];
  if (extraSectionName) {
    // the same name inside a CUSTOM section (id 0) — must NOT be believed
    const n2 = Buffer.from(extraSectionName, "latin1");
    const pay2 = Buffer.concat([Buffer.from([n2.length]), n2]);
    parts.push(Buffer.concat([Buffer.from([0, pay2.length]), pay2]));
  }
  return Buffer.concat(parts);
}

function classifyPy(file, script) {
  const code = script === "manager" ? `
import importlib.util, sys, json, pathlib
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
print(json.dumps(m._component_contract(pathlib.Path(${JSON.stringify(file)}))))
` : `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("gw", ${JSON.stringify(GATEWAY)})
g = importlib.util.module_from_spec(spec); sys.modules["gw"] = g
spec.loader.exec_module(g)
print(json.dumps(g.component_contract(open(${JSON.stringify(file)}, "rb").read())))
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, WASM_MANAGER_PORT: "8091", NODE_HAS_GPU: "0" },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out.trim().split("\n").pop());
}

test("real wasip2 fixtures classify from their exports", () => {
  const http = classifyPy(path.join(FIXTURES, "egress-guest-http.wasm"), "manager");
  assert.equal(http.wasi, "0.2");
  assert.match(http.world, /^wasi:http\/incoming-handler@0\.2\./);
  const run = classifyPy(path.join(FIXTURES, "egress-guest-tcp.wasm"), "manager");
  assert.equal(run.wasi, "0.2");
  assert.match(run.world, /^wasi:cli\/run@0\.2\./);
});

test("a p3 service-world export classifies as 0.3; p3 outranks p2 like serve does", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p3fix-"));
  const p3 = path.join(dir, "p3.wasm");
  writeFileSync(p3, syntheticComponent("wasi:http/handler@0.3.0-rc-2026-03-15"));
  assert.deepEqual(classifyPy(p3, "manager"), { wasi: "0.3", world: "wasi:http/handler@0.3.0-rc-2026-03-15" });
  // `wasmtime serve` tries the p3 ServicePre FIRST and falls back to p2; a
  // dual-world component must classify the same way or routing and runtime
  // would disagree about the same bytes
  const dual = path.join(dir, "dual.wasm");
  const both = Buffer.concat([
    syntheticComponent("wasi:http/incoming-handler@0.2.6").subarray(0, 8),
  ]);
  const n1 = Buffer.from("wasi:http/incoming-handler@0.2.6"), n2 = Buffer.from("wasi:http/handler@0.3.0-rc-2026-03-15");
  const pay = Buffer.concat([Buffer.from([2, n1.length]), n1, Buffer.from([0, 0, 0, n2.length]), n2, Buffer.from([0, 0, 0])]);
  writeFileSync(dual, Buffer.concat([both, Buffer.from([11, pay.length]), pay]));
  assert.equal(classifyPy(dual, "manager").wasi, "0.3");
});

test("a core module and junk classify as nothing, and custom sections are never believed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p3fix-"));
  const core = path.join(dir, "core.wasm");
  writeFileSync(core, syntheticComponent("wasi:http/handler@0.3.0-rc-2026-03-15", { layer: 0 }));
  assert.deepEqual(classifyPy(core, "manager"), { wasi: null, world: null });
  // an export-free component whose CUSTOM section name-drops the p3 world
  // (e.g. embedded WIT text riding in a custom section) must not classify
  const custom = path.join(dir, "custom.wasm");
  const c = syntheticComponent("not-wasi-anything", { extraSectionName: "wasi:http/handler@0.3.0-rc-2026-03-15" });
  writeFileSync(custom, c);
  assert.deepEqual(classifyPy(custom, "manager"), { wasi: null, world: null });
});

test("the gateway's Python twin agrees with the runner's classifier", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p3fix-"));
  const p3 = path.join(dir, "p3.wasm");
  writeFileSync(p3, syntheticComponent("wasi:http/handler@0.3.0-rc-2026-03-15"));
  for (const file of [path.join(FIXTURES, "egress-guest-http.wasm"), path.join(FIXTURES, "egress-guest-tcp.wasm"), p3]) {
    assert.deepEqual(classifyPy(file, "gateway"), classifyPy(file, "manager"), path.basename(file));
  }
});

test("the CLI and browser classifiers are the same algorithm (string-pinned)", () => {
  // same technique as test/publish-cid-verify.test.mjs: the algorithm's
  // load-bearing constants must appear in both JS copies, so a drive-by
  // "simplification" of one of the four lockstep copies fails a test
  for (const rel of [["cli", "enclave.mjs"], ["site", "js", "pages", "apps.js"]]) {
    const src = fs.readFileSync(path.join(REPO, ...rel), "utf8");
    for (const pin of ["wasi:http/handler@0.3.", "wasi:http/incoming-handler@0.2.",
                       "wasi:cli/run@0.3.", "wasi:cli/run@0.2.", "componentContract"]) {
      assert.ok(src.includes(pin), `${rel.join("/")} must carry ${pin}`);
    }
    assert.match(src, /sid === 11|sid === 11/, `${rel.join("/")} reads the export section`);
  }
});

// ---- 4. launch refuses a p3 component on a non-p3 box -----------------------

test("a wasip3 component on a box without p3 fails at launch with words, not exit 2", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "p3apps-"));
  writeFileSync(path.join(dir, "p3app.wasm"), syntheticComponent("wasi:http/handler@0.3.0-rc-2026-03-15"));
  const bin = FAKE(HELP_NO_P3);
  const code = `
import importlib.util, sys, json
spec = importlib.util.spec_from_file_location("wm", ${JSON.stringify(MGR)})
m = importlib.util.module_from_spec(spec); sys.modules["wm"] = m
spec.loader.exec_module(m)
rec = m.launch(${JSON.stringify(path.join(dir, "p3app.wasm"))}, "t", 0.05)
print(json.dumps({"status": rec["status"], "error": rec.get("error"), "wasi": rec.get("wasi")}))
`;
  const out = execFileSync("python3", ["-c", code], {
    env: { ...process.env, WASM_MANAGER_PORT: "8091", NODE_HAS_GPU: "0",
           WASMTIME_BIN: bin, WASM_APPS_DIR: dir, WASM_FS: "0" },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const r = JSON.parse(out.trim().split("\n").pop());
  assert.equal(r.status, "failed");
  assert.equal(r.wasi, "0.3", "the record says what the bytes are");
  assert.match(r.error, /WASIp3/, "the owner's one piece of evidence must name the actual problem");
});

// ---- 5. the capability plumbing, pinned like proofOfTime --------------------

test("manager /health carries p3, supervisor forwards it, the relay ANDs it", () => {
  const mgr = fs.readFileSync(MGR, "utf8");
  assert.match(mgr, /"p3": _p3_active\(\)/, "the manager reports what the box actually serves");
  const sup = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");
  assert.match(sup, /const p3 = PROVISION_BACKEND === "vm" && h\.p3 !== undefined \? \{ p3: h\.p3 === true \} : \{\};/,
    "the supervisor forwards the manager's probed answer, never its own guess");
  assert.match(sup, /\.\.\.nn, \.\.\.lbw, \.\.\.p3, /, "and folds it into /availability");
  const relay = fs.readFileSync(path.join(REPO, "relay", "api-relay.js"), "utf8");
  assert.match(relay, /p3: serving\.length > 0 && serving\.every\(\(e\) => e\.availability\?\.p3 === true\)/,
    "the relay must AND it across the claiming fleet, same as every capability");
});

test("the claim gate refuses wasi-0.3 versions on a box that does not serve p3", () => {
  const sup = fs.readFileSync(path.join(REPO, "supervisor.js"), "utf8");
  assert.match(sup, /wasiOfConfig\(g\.config\) === "0\.3"/, "keyed on the version's declared contract");
  assert.match(sup, /app targets WASIp3 and this box's runtime does not serve it/);
  assert.match(sup, /function wasiOfConfig/, "undeclared/unparseable must mean 0.2 — every pre-p3 version");
});
