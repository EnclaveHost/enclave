// UNREVIEWED, NOT RUN. Executes harness/generate_harness.py on copies of the REAL qualified client-site-browser-r1 inputs
// in an isolated temporary layout and checks every delta, the byte-identical copies, the retained fixture guarantees and
// the refusals. It does not start a server, a browser or Anvil.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cleanup, layout, linesKept, out, read, requirePython, run, sha } from "./layout.mjs";

const GEN = "harness/generate_harness.py";
const SCRIPTS = [GEN, "harness/exec-phases.fragment.js"];
const B = "client-site-browser-r1";
const GUARD = '  if (args.some((a) => /code-size|disable-code-size/.test(a))) fail("no code-size override");';

test("generate_harness: derived server, shell, build driver and page shell", () => {
  requirePython();
  const c = layout("HARNESS-GEN-PINS.json", SCRIPTS);
  try {
    const r = run(c, GEN);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    // server: labelled additions only; every fixture guarantee retained
    const s0 = read(c, `${B}/out/server.mjs`), s = out(c, "out/server.mjs");
    const replaced = s0.split("\n").filter((l) => ['  "eth_getCode", "eth_getLogs"]);', 'const MAX_TICKS = 150;', 'const counters = {', 'owned.dataDir = fs.mkdtempSync(',
      'const HERE = path.resolve('].some((p) => l.startsWith(p)));
    assert.equal(replaced.length, 5, "exactly five server lines are replaced");
    assert.ok(linesKept(s0, s, replaced), "every other server line is kept, in order");
    assert.equal(s.split(GUARD).length - 1, 1, "the unchanged no-code-size-override refusal is present exactly once");
    for (const keep of ['"--chain-id", "8453", "--hardfork", "osaka"', '"--slots-in-an-epoch", "1"', "if (req.headers.host !== here)",
      "let dropFirstFundingOpen = true;", "default-src 'none'", "maxSeconds must be 30..1800", "owned.anvil.stop()"]) {
      assert.ok(s.includes(keep), `server keeps ${keep}`);
    }
    assert.match(s, /"eth_getCode", "eth_getLogs", "eth_getTransactionByHash"\]\);/);
    assert.equal(/eth_sendRawTransaction|anvil_|evm_setNextBlock/.test(s.split("const RPC_ALLOW")[1].split(");")[0]), false, "the RPC allowlist stays read-only");
    assert.match(s, /if \(p === "\/test\/fixture\/execute-fault"\) \{/);
    assert.match(s, /if \(k === "POST \/v1\/sessions\/funding\/execute" && executeFault\) \{[\s\S]*?counters\.executeFaults\.push\(mode\)/);
    assert.ok(s.indexOf('if (k === "POST /v1/sessions/funding/execute" && executeFault)') < s.indexOf("return svc.handle(req, res, u, {})"),
      "the execute fault wraps the reply of the REAL service handling");
    assert.match(s, /const MAX_TICKS = 250;/);
    // shell: page import, successor journal checks, phases 12-16, owner controls after them
    const m0 = read(c, `${B}/shell/main.mjs`), m = out(c, "shell/main.mjs");
    assert.ok(m.includes('await import("../../client-execution-site-r2/candidate/site/js/pages/funding.js")'));
    assert.equal(m.includes("client-site-repair-r2/authored/site/js/pages/funding.js"), false);
    for (const p of ["pExecFinal", "pExecLost", "pExecReload", "pExec502", "pExecSwitch"]) assert.equal(m.split(`phase("${p}", `).length - 1, 1, p);
    assert.match(m, /phase\("pControls", "10\. Intake OFF[^"]*", "execDone", async/);
    assert.ok(m.indexOf('phase("pExecSwitch"') < m.indexOf('phase("pControls"'));
    assert.match(m, /lower\(x\.call\?\.digest\) === digest/);
    assert.match(m, /check\(t\.includes\(e\.status === "settled" \? "\(final on chain\)" : "NOT final yet"\)/);
    for (const keep of ['phase("pStart", ', 'phase("pSignSend", ', 'phase("pRecover", ', 'phase("pSwitch2", ', 'phase("pQuote", ', 'phase("pNullCheck", ',
      "15 owner prompts in total", "no enabled button anywhere on the page"]) assert.ok(m.includes(keep), `shell keeps ${keep}`);
    const fragment = fs.readFileSync(path.join(c.stage, "harness/exec-phases.fragment.js"), "utf8");
    assert.ok(m.includes(fragment), "phases 12-16 are inserted verbatim");
    for (const bad of ["confirmGasFund(", "reconcileGasExecution(", "quoteGasFund(", "signDigest("]) assert.equal(fragment.includes(bad), false, `phases never call the core directly (${bad})`);
    assert.ok(linesKept(m0.replace(/[^\n]*\n/, ""), m, m0.split("\n").filter((l) => l.includes("await import(\"../../client-site-repair-r2") || l.includes("/^(Funded:|Sent;)/")
      || l.includes('lower(x.digest) === digest') || l.includes('e.status === "settled" && lower(e.deployment)') || l.includes("BigInt(e.actual.totalDebit6)")
      || l.startsWith('phase("pControls"'))), "every other shell line is kept, in order");
    // build driver
    const bd = out(c, "build/build-harness.mjs");
    assert.ok(bd.startsWith("#!/usr/bin/env node\n"));
    assert.ok(bd.includes('const PAGE = abs("client-execution-site-r2/candidate/site/js/pages/funding.js");'));
    assert.ok(bd.includes('["../../client-execution-site-r2/candidate/site/js/pages/funding.js", PAGE],'));
    assert.ok(bd.includes('!rel.endsWith("/vendor/funding.js") && !rel.includes("sdk/sessions/dist")'));
    assert.ok(bd.includes('if (esbuildPkg.name !== "esbuild" || esbuildPkg.version !== ESBUILD_VERSION)'), "esbuild version pin kept");
    // copies + page shell
    for (const f of ["harness-state.js", "facade/api.js", "facade/wallet.js", "facade/empty.js", "facade/config.js", "facade/sessions.js", "facade/vendor-funding.js"]) {
      assert.equal(out(c, `shell/${f}`), read(c, `${B}/shell/${f}`), f);
    }
    const page = out(c, "page/index.html");
    assert.ok(page.includes('<div id="fdBody" class="co-body"></div>') && page.includes('<script type="module" src="/dist/harness.js"></script>'));
    const gen = JSON.parse(out(c, "out/GENERATED.json"));
    for (const [p, h] of Object.entries(gen.outputs)) assert.equal(h, sha(fs.readFileSync(path.join(c.stage, p))), p);
    assert.notEqual(run(c, GEN).status, 0, "a second run refuses: out/ exists");
  } finally { cleanup(c); }
});

test("generate_harness refuses drift, a null pin, a removed guard and an existing output directory", () => {
  requirePython();
  const cases = [
    ["drift", (c) => fs.appendFileSync(path.join(c.uf, `${B}/shell/main.mjs`), "\n"), /!= pinned/],
    ["null pin", (c) => { c.pins.inputs[`${B}/build/build-harness.mjs`] = null; }, /no root-filled sha256/],
    ["guard removed", (c) => { const f = path.join(c.uf, `${B}/out/server.mjs`); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(`${GUARD}\n`, "")); c.repin(); },
      /no-code-size-override refusal must remain exactly once/],
    ["existing output", (c) => fs.mkdirSync(path.join(c.stage, "shell"), { recursive: true }), /shell\/ already exists/],
  ];
  for (const [what, tweak, re] of cases) {
    const c = layout("HARNESS-GEN-PINS.json", SCRIPTS, tweak);
    try {
      const r = run(c, GEN);
      assert.notEqual(r.status, 0, what);
      assert.match(r.stderr + r.stdout, re, what);
      assert.equal(fs.existsSync(path.join(c.stage, "out")), false, `${what}: nothing written`);
    } finally { cleanup(c); }
  }
});
