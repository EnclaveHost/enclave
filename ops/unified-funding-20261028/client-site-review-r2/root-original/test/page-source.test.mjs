// UNREVIEWED, NOT RUN. Source-level checks of the authored /funding page, helpers and build script (text only).
// They catch regressions of wiring rules that the executable tests (state / flows / generator) cannot reach without a
// browser; they do not prove the page works. Comments and string literals are stripped before identifier checks
// (r1's purity check failed on the word "window." inside a comment).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(HERE, p), "utf8");
const page = read("authored/site/js/pages/funding.js");
const state = read("authored/site/js/funding/state.js");
const flows = read("authored/site/js/funding/flows.js");
const build = read("authored/scripts/build-funding-vendor.mjs");
/** Code only: block/line comments and string/template literals removed. */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1")
  .replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g, '""');

test("the code stripper keeps code and drops comments/strings (so the purity checks below mean something)", () => {
  assert.equal(code('a /* window.x */ + b // document.y\n"window.z"'), 'a  + b \n""');
  assert.match(code("const w = window.location;"), /\bwindow\s*\./);
});

test("state.js and flows.js are pure: no DOM, storage, network or globals; flows imports only state.js", () => {
  for (const [name, src] of [["state.js", state], ["flows.js", flows]]) {
    const c = code(src);
    for (const bad of ["window", "document", "localStorage", "sessionStorage", "indexedDB", "fetch", "globalThis", "setTimeout", "setInterval", "Date"]) {
      assert.equal(new RegExp(`\\b${bad}\\b`).test(c), false, `${name} uses ${bad}`);
    }
  }
  assert.equal(/^\s*import\s/m.test(state), false, "state.js imports nothing");
  assert.deepEqual(flows.match(/^import .*$/gm), ['import * as ST from "./state.js";']);
});

test("page: no wallet discovery, timers, deletion, raw JSON input or hard-coded approval", () => {
  const c = code(page);
  for (const bad of ["window.ethereum", "setTimeout(", "setInterval(", "deleteDatabase", ".remove(", "JSON.parse(", "rootReviewed"]) {
    assert.equal(c.includes(bad), false, `page code contains ${bad}`);
  }
  assert.equal(page.includes("<textarea"), false);
});

test("page: every click is guarded; effects go through the flows / guarded boundaries, never the raw provider or relay", () => {
  const c = code(page);
  assert.match(page, /function mount\(\) \{\s*epoch \+= 1;\s*memory\.clear\(\);/);
  assert.match(page, /on\("enclave:wallet", \(\) => \{ if \(\$\("#fdBody"\)\) mount\(\); \}\);/);
  assert.match(page, /const g = FL\.createGuard\(live\);/);
  const clicks = page.match(/addEventListener\("click", act\(e, owner, async \(g\) =>/g) || [];
  assert.equal(clicks.length, 10, "end, terminate, withdraw, prepare, reconcile, sign, send, rearm, quote, fund");
  assert.match(page, /fund\.addEventListener\("click", act\(e, owner, async \(g\) =>/);
  for (const raw of [/provider: Enclave\.provider(?!, core)/, /c\.f\.signSteps\(/, /c\.f\.runMigration\(/, /c\.f\.quoteGasFund\(/, /c\.f\.confirmGasFund\(/]) {
    assert.doesNotMatch(c, raw, `raw effect call ${raw}`);
  }
  assert.match(page, /FL\.signFlow\(\{ \.\.\.flowArgs\(g\), shown, provider: Enclave\.provider, core: c\.f,/, "signFlow wraps the provider itself");
  assert.match(page, /c\.f\.reconcileMigration\(stepCtx\(c, g\), plan\.id\)/);
  assert.match(page, /c\.f\.rearmStep\(\{ \.\.\.stepCtx\(c, g\), rng: undefined \}/);
  assert.match(page, /gasStore: FL\.guardGasStore\(c\.gasStore, g\), relayBase: relayRoot\(\)/);
  assert.equal((page.match(/FL\.guardProvider\(Enclave\.provider, g\)/g) || []).length, 2, "owner terminate + withdraw prompts are guarded");
});

test("page: plans need relay evidence; display is the plan's own terms; sign/send need proposal match + approval", () => {
  assert.match(page, /ST\.selectPlans\(entries, c\.ctx, np\.oldSid, records\)/);
  assert.match(page, /const tv = ST\.termsView\(plan\);/);
  assert.match(page, /ST\.moneyRows\(\{ original6: tv\.original6, legacy6: tv\.legacy6, parts: tv\.parts \}\)/);
  assert.match(page, /const canSign = appr\.ok && match\.ok && next\.length > 0 && !signedReady;/);
  assert.match(page, /id="fdRun" \$\{signedReady && match\.ok && appr\.ok \? "" : "disabled"\}/);
  assert.match(page, /loadLegacyEvidence\(\{ S: c\.S, legacyStore: c\.legacyStore, sid: np\.oldSid,/, "the original stored grant is required");
});

test("page: the quote survives a re-render, input changes drop it, and fund sends the displayed digest", () => {
  assert.match(page, /const start = memory\.quoteInputs\(c\.ctx\) \?\?/);
  assert.match(page, /show\(\);\s+\/\/ a normal re-render shows the same held quote again/);
  assert.match(page, /const changed = \(\) => \{ memory\.dropQuote\(\);/);
  assert.match(page, /for \(const id of \["#fdDep", "#fdEth", "#fdTier"\]\) \{ \$\(id\)\.addEventListener\("input", changed\); \$\(id\)\.addEventListener\("change", changed\); \}/);
  assert.match(page, /shownDigest: out\.dataset\.digest \|\| ""/);
});

test("page: owner controls render first and never wait for intake, catalog, scope or relay config", () => {
  const controls = page.slice(page.indexOf("async function renderControls"), page.indexOf("async function context"));
  for (const bad of ["verifyRuntime", "freshRecoveryScope", "sessionsConfig", "/funding/config", "intake"]) {
    assert.equal(code(controls).includes(bad), false, `controls depend on ${bad}`);
  }
  assert.ok(page.indexOf("await renderControls(e, owner)") < page.indexOf("await renderMigration(e, owner)"));
  assert.ok(page.indexOf("await renderControls(e, owner)") < page.indexOf("Number(Enclave.chainId) !== CHAIN"), "controls render even off Base");
});

test("vendor build validates before writing and enforces viem's declared dependency closure", () => {
  assert.match(build, /write: false,/);
  assert.ok(build.indexOf("fs.writeFileSync(OUT, bytes)") > build.indexOf("if (missing.length) refuse"), "writes only after every check");
  assert.ok(build.indexOf("fs.writeFileSync(OUT, bytes)") > build.indexOf("if (notAllowed.length) refuse"));
  assert.equal((code(build).match(/fs\.writeFileSync\(/g) || []).length, 2, "the bundle and its manifest, nothing else");
  assert.match(build, /import \{ build \} from "esbuild";/);
});
