// migration-cutover-fault-r2 focused OFFLINE checks (UNREVIEWED, NOT RUN by its author). Reads local files only: no
// network, no browser, no anvil. Run AFTER fixture/generate_fixture.py and run-build-r2.py:
//   node --test migration-cutover-fault-r2/test/fault-r2.test.mjs
// The strict "only these edits" guarantee is the generator's own: every anchor exactly once, and reversing the edits must
// give back each pinned qualified input byte for byte. These checks re-verify the results independently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const UF = path.dirname(HERE);
const M = "migration-cutover-fault-r2";
const R = "migration-cutover-site-review-r1";
const sha = (p) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const read = (p) => fs.readFileSync(p, "utf8");
const count = (s, x) => s.split(x).length - 1;
const gen = JSON.parse(read(path.join(HERE, "out", "GENERATED.json")));

test("generator outputs are exactly the recorded bytes; inputs are root's review-r1 manifest values", () => {
  for (const [rel, h] of Object.entries(gen.outputs)) assert.equal(sha(path.join(HERE, rel)), h, rel);
  const rg = JSON.parse(read(path.join(UF, R, "out", "GENERATED.json"))).outputs;
  for (const [rel, h] of Object.entries(gen.inputs)) {
    assert.equal(sha(path.join(UF, rel)), h, rel);
    const short = rel.slice(R.length + 1);
    if (rg[short]) assert.equal(rg[short], h, `${rel} vs review-r1 out/GENERATED.json`);
  }
  for (const f of ["api.js", "wallet.js", "empty.js", "sessions.js", "vendor-funding.js", "config.js"]) {
    assert.equal(sha(path.join(HERE, "shell", "facade", f)), sha(path.join(UF, R, "shell", "facade", f)), `facade ${f} copied unchanged`);
  }
  assert.equal(sha(path.join(HERE, "shell", "harness-state.js")), sha(path.join(UF, R, "shell", "harness-state.js")), "harness-state.js copied unchanged");
});

test("the code under test is byte-identical to the qualified review-r1 build (page, flows, state, util, vendor f23ba2d7..., sessions SDK)", () => {
  const rp = JSON.parse(read(path.join(UF, R, "generated", "BUILD-PINS.json"))).inputs;
  const bp = JSON.parse(read(path.join(HERE, "generated", "BUILD-PINS.json"))).inputs;
  for (const [rel, h] of Object.entries(gen.unchangedUnderTest)) {
    assert.equal(sha(path.join(UF, rel)), h, rel);
    assert.equal(rp[rel], h, `${rel} vs review-r1 BUILD-PINS`);
    assert.equal(bp[rel], h, `${rel} vs this BUILD-PINS`);
  }
  assert.equal(gen.unchangedUnderTest[`${R}/candidate/site/vendor/funding.js`], "f23ba2d79661ade43ed484e186d0347b95756dbe70a9735c4b3152da653dd957");
  for (const [rel, h] of Object.entries(bp)) assert.equal(sha(path.join(UF, rel)), h, rel);
  const hi = JSON.parse(read(path.join(HERE, "generated", "HARNESS-INPUTS.json")));
  for (const [rel, h] of Object.entries(hi.files)) assert.equal(sha(path.join(UF, rel)), h, rel);
  assert.deepEqual(hi.vendor, JSON.parse(read(path.join(UF, R, "generated", "HARNESS-INPUTS.json"))).vendor);
});

test("server: every bound and guard kept; the two new faults are labelled, one-shot and bounded", () => {
  const s = read(path.join(HERE, "out", "server.mjs"));
  for (const keep of ["const MAX_PROMPTS = 24;", "const MAX_TICKS = 250;", "maxSeconds < 30 || maxSeconds > 1800", 'fail("no code-size override")',
    "if (req.headers.host !== here)", 'owned.server.listen(port, "127.0.0.1"', "fs.rmSync(owned.dataDir", "let dropFirstFundingOpen = true;",
    "const MIN_ADVANCE_S = 60, MAX_ADVANCE_S = 1200;", "the TEST time advance is one-shot per run", "the owner reply fault is one-shot per run",
    '"txpool_status"', "notAfter: unix() + maxSeconds + 600 + MAX_ADVANCE_S", `if (p === "/test/fixture/owner-reply-fault") {   // ${M}`,
    `if (p === "/test/fixture/advance-time") {   // ${M}`, `if (k === "POST /v1/sessions/owner" && ownerReplyFault) {   // ${M}`]) assert.equal(count(s, keep), 1, keep);
  assert.equal(count(s, '"evm_increaseTime"'), 1);
  assert.equal(count(s, "Date.now = "), 1);
  assert.ok(count(s, M) >= 12, "labelled lines present");
  for (const bad of ["https://", "evm_setNextBlockTimestamp", "anvil_setCode", "anvil_impersonate", "pkill", "process.kill(-", "window.ethereum"]) assert.equal(count(s, bad), 0, bad);
});

test("shell: changed phases labelled; click order; prompt total 21; peer whitelist; no database clearing or wallet discovery added", () => {
  const src = read(path.join(UF, R, "shell", "main.mjs"));
  const m = read(path.join(HERE, "shell", "main.mjs"));
  const oldLines = new Set(src.split("\n"));
  for (const line of m.split("\n").filter((l) => l.startsWith("phase(") && !oldLines.has(l))) assert.ok(line.includes(M), `unlabelled changed phase: ${line.slice(0, 80)}`);
  const at = gen.phases.order.map((id) => m.indexOf(`phase("${id}", `));
  assert.ok(at.every((i) => i >= 0), "every phase defined");
  assert.deepEqual(gen.phases.new.map((id) => m.indexOf(`phase("${id}", `)), [...gen.phases.new.map((id) => m.indexOf(`phase("${id}", `))].sort((a, b) => a - b), "C phases in click order");
  for (const id of [...gen.phases.new, ...gen.phases.kept]) assert.equal(count(m, `phase("${id}", `), 1, id);
  assert.equal(count(m, "s.prompts.length === 21"), 1);
  assert.equal(count(m, 'const PEER_CLICKS = new Set(["#fdActivate", "#fdRec", "#fdSign", "#fdRun"]);'), 1);
  for (const same of ["indexedDB.deleteDatabase", '"interrupted"', "sessionStorage.clear()", "localStorage.removeItem"]) assert.equal(count(m, same), count(src, same), same);
  for (const bad of ["window.ethereum", "eth_requestAccounts", "https://", "indexedDB.open", "eval("]) assert.equal(count(m, bad), count(src, bad), bad);
  for (const need of ['"/test/fixture/owner-reply-fault"', '"/test/fixture/advance-time"', "lostTerminateTx", 'raceClick("#fdActivate")', 'raceClick("#fdRun")',
    "forced Send without fresh signatures: nothing admitted", "renderHistory(st);"]) assert.ok(m.includes(need), need);
});

test("page shell: no stale provenance paragraph; clock + cumulative history visible; title is TEST ONLY", () => {
  const h = read(path.join(HERE, "page", "index.html"));
  assert.ok(!h.includes("client-execution-site-r2 generated copy") && !h.includes("client-site-repair-r2 files, unmodified"));
  assert.ok(h.includes('<div id="hclock">') && h.includes('<ol id="hhistory"></ol>') && h.includes("<title>TEST ONLY - "));
  assert.ok(h.includes(`${R} candidate`) && h.includes("byte-unchanged"));
});
