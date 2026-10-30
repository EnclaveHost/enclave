// UNREVIEWED, NOT RUN. Source-level checks of the authored /funding page and helpers (text only: no DOM, no execution).
// They catch regressions of the integration rules; they do not prove the page works in a browser.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(HERE, p), "utf8");
const page = read("authored/site/js/pages/funding.js");
const state = read("authored/site/js/funding/state.js");
const build = read("authored/scripts/build-funding-vendor.mjs");
const gen = read("generator/generate.py");
const pins = JSON.parse(read("generated/SOURCE-PINS.json")).inputs;

test("page: no wallet discovery, no timers, no deletion, no raw JSON input, no hard-coded approval", () => {
  for (const bad of ["window.ethereum", "eth_requestAccounts", "setTimeout(", "setInterval(", "deleteDatabase", "localStorage.removeItem",
    ".remove(", "rootReviewed: true", "rootReviewed:true", "JSON.parse(", "<textarea", "relayClient(origin", "wireFetch"]) {
    assert.equal(page.includes(bad), false, `page contains ${bad}`);
  }
});

test("page: remount clears held state; wallet change remounts; every action is epoch + owner bound", () => {
  assert.match(page, /function mount\(\) \{\s*epoch \+= 1;\s*memory\.clear\(\);/);
  assert.match(page, /on\("enclave:wallet", \(\) => \{ if \(\$\("#fdBody"\)\) mount\(\); \}\);/);
  assert.match(page, /if \(e !== epoch \|\| ownerNow\(\) !== owner\)/);
  const clicks = page.match(/addEventListener\("click", act\(e, owner,/g) || [];
  assert.ok(clicks.length >= 8, `every state-changing click goes through act(): ${clicks.length}`);
});

test("page: plans and records are always scoped; signing needs the exact approval; sends need the bound bundle", () => {
  assert.match(page, /ST\.selectPlans\(await c\.gasStore\.listJournal\(\), c\.ctx, np\.oldSid\)/);
  assert.ok((page.match(/ST\.selectOwnRecords\(/g) || []).length >= 4);
  assert.match(page, /const ok = ST\.approvalStatus\(FUNDING_MIGRATION_APPROVAL, fresh, c\.ctx\);\s*if \(!ok\.ok\)/);
  assert.match(page, /approval: ok\.approval/);
  assert.match(page, /const bundle = memory\.signedFor\(c\.ctx, fresh\);\s*if \(!bundle\)/);
  assert.match(page, /memory\.dropSigned\(\);\s*\/\/ single use/);
  assert.match(page, /memory\.takeQuote\(c\.ctx, record, shown\.dep, nowS\(\)\)/);
  assert.match(page, /ST\.activePointerDecision\(lsGet\(WALLET_SESSION_KEY\), newSid, oldSid\)/);
  assert.match(page, /loadLegacyEvidence\(\{ S: c\.S, legacyStore: c\.legacyStore, sid: np\.oldSid,/, "the original stored grant is required");
});

test("page: owner controls are rendered first and never wait for intake, catalog, scope or relay config", () => {
  const controls = page.slice(page.indexOf("async function renderControls"), page.indexOf("async function context"));
  for (const bad of ["verifyRuntime", "freshRecoveryScope", "sessionsConfig", "/funding/config", "intake"]) {
    assert.equal(controls.includes(bad), false, `controls depend on ${bad}`);
  }
  assert.ok(page.indexOf("await renderControls(e, owner)") < page.indexOf("await renderMigration(e, owner)"));
});

test("state helpers are pure; the build script uses only existing esbuild and refuses drift", () => {
  assert.equal(/^\s*import\s/m.test(state), false, "state.js imports nothing");
  for (const bad of ["fetch(", "indexedDB", "localStorage", "document.", "window."]) assert.equal(state.includes(bad), false, `state.js uses ${bad}`);
  assert.match(build, /import \{ build \} from "esbuild";/);
  assert.match(build, /refusing to build/);
});

test("generator: refuses unpinned input, proves reversible rewrites, writes only under candidate/", () => {
  assert.match(gen, /OUT = HERE \/ "candidate"/);
  assert.match(gen, /no root-filled sha256 \(refusing\)/);
  assert.match(gen, /the rewrite is not exactly reversible/);
  assert.match(gen, /the patch is not exactly reversible/);
  assert.match(gen, /a \.\.\/ import specifier remains after rewriting/);
  assert.match(gen, /f = OUT \/ p\n\s*f\.parent\.mkdir\(parents=True, exist_ok=True\)\n\s*f\.write_bytes\(b\)/);
  assert.match(gen, /\(OUT \/ "INSTALL-MANIFEST\.json"\)\.write_text/);
  assert.equal((gen.match(/\.write_(bytes|text)\(/g) || []).length, 2, "exactly the two writes above");
});

test("generator: /funding ships (boot PAGES, build-site PAGE_HTML + HTML list, _redirects), and config stays null", () => {
  assert.match(gen, /funding: {3}\(\) => import\("\.\/pages\/funding\.js"\)/);
  assert.match(gen, /sessions: "sessions\.html", funding: "funding\.html" \};/);
  assert.match(gen, /"sessions\.html", "funding\.html", "404\.html"/);
  assert.match(gen, /\/funding {4}\/funding\.html {4}200\\n/);
  for (const n of ["FUNDING_RUNTIME", "FUNDING_MIGRATION_PROPOSAL", "FUNDING_MIGRATION_APPROVAL"]) {
    assert.match(gen, new RegExp(`export const ${n} = null;`));
  }
  for (const p of ["../source/scripts/build-site.mjs", "../source/site/_redirects", "../source/site/js/boot.js",
    "../source/site/js/core/config.js", "../source/site/sessions.html"]) {
    assert.ok(Object.hasOwn(pins, p), `${p} is a pinned input`);
  }
});
