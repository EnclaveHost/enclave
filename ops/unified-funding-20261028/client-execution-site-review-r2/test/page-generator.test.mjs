// UNREVIEWED, NOT RUN. Executes generator/generate_page.py on copies of the REAL pinned inputs in an isolated temporary
// layout and checks the generated recovery page copy, builder, core copy, install/rollback manifest and the refusals.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cleanup, code, layout, linesKept, out, read, requirePython, run, sha } from "./layout.mjs";

const GEN = "generator/generate_page.py";
const R2A = "client-site-repair-r2/authored", R2C = "client-site-repair-r2/candidate", PREP = "client-execution-recovery-r1/prepared/sdk/funding";
const OLD_FUND = ['      scope, core: c.f, fundArgs: { runtime: c.runtime, relay: c.relay, rpc: c.rpc }, now: nowS });',
  '    return r.pending ? "Sent; waiting for chain confirmation" : `Funded: ${usd(r.settlement.actual.totalDebit6)} used`;'];
const OLD_MUST = '  "buildMigrationPlan", "signSteps", "runMigration", "reconcileMigration", "rearmStep"];';

test("generate_page: the recovery page copy, builder, core copy and install/rollback manifest", () => {
  requirePython();
  const c = layout("PAGE-PINS.json", [GEN]);
  try {
    const r = run(c, GEN);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const page0 = read(c, `${R2A}/site/js/pages/funding.js`);
    const page = out(c, "candidate/site/js/pages/funding.js");
    // only additions, plus the two replaced fund lines
    assert.ok(linesKept(page0, page, OLD_FUND), "every other line of the proven r2 page is kept, in order");
    for (const l of OLD_FUND) assert.equal(page.includes(l), false, "the old fund lines are replaced");
    // owner controls byte-identical
    const slice = (s) => s.slice(s.indexOf("async function renderControls"), s.indexOf("async function context"));
    assert.equal(slice(page), slice(page0), "renderControls .. context is byte-identical (owner controls preserved)");
    // order: controls, then the recovery section, then the Base check / migration / gas
    const iC = page.indexOf("  await renderControls(e, owner);"), iX = page.indexOf("  await renderExecutions(e, owner);"), iB = page.indexOf("Number(Enclave.chainId) !== CHAIN");
    assert.ok(iC > 0 && iC < iX && iX < iB, "the recovery section renders right after the controls, before the Base check");
    assert.match(page, /<section id="fdExec"><h3>Gas payments<\/h3><p>Loading…<\/p><\/section>/);
    // the recovery section: read-only, guarded, scoped, independent of catalog / sessions config / intake / migration
    const rx = page.slice(page.indexOf("async function renderExecutions"), page.indexOf("async function setActive"));
    const rc = code(rx);
    for (const bad of ["sessionsConfig", "context(", "freshRecoveryScope", "confirmGasFund", "quoteGasFund", "signSteps", "runMigration",
      "ownerControl", "endGasSession", "Enclave.provider", "guardProvider", "putJournal", "casJournal", "deleteDatabase"]) {
      assert.equal(rc.includes(bad), false, `the recovery section must not use ${bad}`);
    }
    assert.match(rx, /ST\.selectOwnRecords\(await store\.listKeys\(\), ST\.controlsContextOf\(\{ owner, chainId: CHAIN, vault: target\.vault, relay: relayRoot\(\) \}\)\)/);
    assert.match(rx, /f\.listGasExecutions\(entries, r\)\.filter\(\(x\) => x\.blocking\)/);
    assert.match(rx, /act\(e, owner, async \(g\) =>/);
    assert.match(rx, /f\.reconcileGasExecution\(\{ runtime, store: FL\.guardGasStore\(store, g\), rpc, relay: FL\.guardRelayFn\(relay, g\),\n\s+relayBase: relayRoot\(\), id: el\.dataset\.exec \}\)/);
    assert.match(rx, /f\.verifyRuntime\(\{ pins: FUNDING_RUNTIME, rpc, relay, owner, now: nowS\(\) \}\)/, "the existing verifyRuntime (no fake-success shim)");
    for (const s of ["Outcome unknown: it may have been processed. It is never resent.", "On chain, but not final yet.", "Check status on chain (read-only)",
      "A check never signs or resends anything."]) assert.ok(page.slice(page.indexOf("const EXEC_LABEL"), page.indexOf("async function setActive")).includes(s), `plain wording: ${s}`);
    // the payment: bound to this relay, page guard right before dispatch, truthful messages
    assert.equal((page.match(/relayBase: relayRoot\(\),   \/\/ client-execution-site-r2/g) || []).length, 1);
    assert.equal((page.match(/dispatchGuard: \(\) => g\.check\("sending the payment"\)/g) || []).length, 1);
    assert.ok(page.includes("used (final on chain)") && page.includes("used (on chain, NOT final yet: Gas payments keeps it until a check proves finality)"));
    assert.equal(/all done/i.test(page), false);
    assert.match(page, /const execOpen = recs\.flatMap\(\(r\) => c\.f\.listGasExecutions\(execEntries, r\)\.filter\(\(x\) => x\.blocking\)\);/);
    assert.equal((page.match(/addEventListener\("click", act\(e, owner, async \(g\) =>/g) || []).length, 11, "the 10 r2 clicks + Check status");
    for (const bad of ["FUNDING_RUNTIME =", "FUNDING_MIGRATION_PROPOSAL =", "FUNDING_MIGRATION_APPROVAL =", "rootReviewed: true", "window.ethereum"]) {
      assert.equal(page.includes(bad), false, bad);
    }
    // builder: only the two recovery exports added to MUST
    const b0 = read(c, `${R2A}/scripts/build-funding-vendor.mjs`), b = out(c, "candidate/scripts/build-funding-vendor.mjs");
    assert.ok(linesKept(b0, b, [OLD_MUST]));
    assert.match(b, /"rearmStep",\n  "reconcileGasExecution", "listGasExecutions"\];/);
    // the successor core: byte for byte the root-prepared files
    for (const f of ["util.mjs", "v2-store.mjs", "chain-proof.mjs", "funding-client.mjs", "migration.mjs", "funding-codec.mjs", "gas-execution.mjs", "browser-entry.mjs", "MANIFEST.json"]) {
      assert.equal(out(c, `candidate/sdk/funding/${f}`), read(c, `${PREP}/${f}`), f);
    }
    // install + rollback
    const man = JSON.parse(out(c, "candidate/INSTALL-MANIFEST.json"));
    const T = man.targets;
    for (const [t, from] of [["site/js/pages/funding.js", `${R2C}/site/js/pages/funding.js`], ["scripts/build-funding-vendor.mjs", `${R2C}/scripts/build-funding-vendor.mjs`],
      ["sdk/funding/browser-entry.mjs", `${R2C}/sdk/funding/browser-entry.mjs`], ["sdk/funding/MANIFEST.json", `${R2C}/sdk/funding/MANIFEST.json`]]) {
      assert.equal(T[t].action, "replace", t);
      assert.equal(T[t].replaces_sha256, sha(fs.readFileSync(path.join(c.uf, from))), t);
      assert.equal(out(c, `candidate/ROLLBACK/${t}`), read(c, from), `${t}: rollback copy is the replaced bytes`);
      assert.equal(T[t].sha256, sha(fs.readFileSync(path.join(c.stage, "candidate", t))), t);
    }
    assert.deepEqual([T["sdk/funding/gas-execution.mjs"].action, T["sdk/funding/gas-execution.mjs"].must_not_exist], ["new", true]);
    for (const f of ["util.mjs", "v2-store.mjs", "chain-proof.mjs", "funding-client.mjs", "migration.mjs", "funding-codec.mjs"]) assert.equal(T[`sdk/funding/${f}`].action, "unchanged", f);
    for (const t of ["site/js/funding/flows.js", "site/js/funding/state.js"]) {
      assert.equal(T[t].sha256, sha(fs.readFileSync(path.join(c.uf, `${R2A}/${t}`))), `${t}: unchanged, not output`);
      assert.equal(fs.existsSync(path.join(c.stage, "candidate", t)), false);
    }
    assert.equal(fs.existsSync(path.join(c.stage, "candidate", "site/js/core/config.js")), false, "config.js is never output");
    assert.notEqual(run(c, GEN).status, 0, "a second run refuses: candidate/ exists");
  } finally { cleanup(c); }
});

test("generate_page refuses drift, a null pin, a non-null FUNDING_* default, a candidate that differs, and a missing anchor", () => {
  requirePython();
  const cases = [
    ["drift", (c) => fs.appendFileSync(path.join(c.uf, `${PREP}/gas-execution.mjs`), "\n"), /!= pinned/],
    ["null pin", (c) => { c.pins.inputs[`${R2C}/site/js/core/config.js`] = null; }, /no root-filled sha256/],
    ["FUNDING default", (c) => { const f = path.join(c.uf, `${R2C}/site/js/core/config.js`);
      fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("export const FUNDING_RUNTIME = null;", "export const FUNDING_RUNTIME = {};")); c.repin(); }, /FUNDING_RUNTIME = null/],
    ["candidate page differs", (c) => { fs.appendFileSync(path.join(c.uf, `${R2C}/site/js/pages/funding.js`), "\n"); c.repin(); }, /not byte-identical/],
    ["prepared core differs from its manifest", (c) => { fs.appendFileSync(path.join(c.uf, `${PREP}/util.mjs`), "\n"); c.repin(); }, /differs from the prepared MANIFEST/],
    ["anchor gone", (c) => { const f = path.join(c.uf, `${R2A}/site/js/pages/funding.js`), g = path.join(c.uf, `${R2C}/site/js/pages/funding.js`);
      const t = fs.readFileSync(f, "utf8").replace('    <button class="btn" id="fdQuote">Get quote</button>\n', ""); fs.writeFileSync(f, t); fs.writeFileSync(g, t); c.repin(); }, /anchor occurs 0 times/],
  ];
  for (const [what, tweak, re] of cases) {
    const c = layout("PAGE-PINS.json", [GEN], tweak);
    try {
      const r = run(c, GEN);
      assert.notEqual(r.status, 0, what);
      assert.match(r.stderr + r.stdout, re, what);
      assert.equal(fs.existsSync(path.join(c.stage, "candidate")), false, `${what}: nothing written`);
    } finally { cleanup(c); }
  }
});
