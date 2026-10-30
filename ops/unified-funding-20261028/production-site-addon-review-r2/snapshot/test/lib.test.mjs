// Focused unit tests of the addon checks (node --test test/). No network, no source checkout needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "../lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const nullCfg = () => ({ schema: L.CONFIG_SCHEMA, release: "disabled", reviewed: false, overrides: [], acceptLegacy: [],
  funding: { FUNDING_RUNTIME: null, FUNDING_MIGRATION_PROPOSAL: null, FUNDING_MIGRATION_APPROVAL: null } });

// ---- exact, reversible path replacements ----
test("applyExact replaces once and reverses to the original bytes", () => {
  const src = `const lib = async () => (F ??= await import("/vendor/funding.js"));\n`;
  const r = L.applyExact("f", src, L.sourceReplacements({ sessionsUrl: "/vendor/s.v.js", fundingUrl: "/vendor/funding.funding-r2.abc.js" })["site/js/pages/funding.js"]);
  assert.equal(r.text, `const lib = async () => (F ??= await import("/vendor/funding.funding-r2.abc.js"));\n`);
  assert.equal(r.reverseEqual, true);
  assert.equal(r.text.replace(r.records[0].to, r.records[0].from), src);
});
test("applyExact refuses absent, duplicated or pre-existing targets", () => {
  assert.throws(() => L.applyExact("f", "x", [["y", "z"]]), /found 0/);
  assert.throws(() => L.applyExact("f", "yy", [["y", "z"]]), /found 2/);
  assert.throws(() => L.applyExact("f", "y z", [["y", "z"]]), /already present/);
  assert.throws(() => L.applyExact("f", "y", [["y", "y"]]), /identity/);
});
test("router imports become the addon hard navigation, nothing else", () => {
  const R = L.sourceReplacements({ sessionsUrl: "/vendor/s.js2", fundingUrl: "/vendor/f.js2" });
  assert.deepEqual(Object.keys(R).sort(), ["site/components/wallet-button/wallet-button.js", "site/js/core/sessions.js",
    "site/js/core/wallet.js", "site/js/pages/funding.js"]);
  const wb = `import { navigate } from "../../js/boot.js";\nnavigate("dashboard", { push: true });`;
  assert.match(L.applyExact("wb", wb, R["site/components/wallet-button/wallet-button.js"]).text, /from "enclave-addon:hard-nav";/);
  const w = `(await import("../boot.js")).navigate("checkout", { push: true });`;
  assert.equal(L.applyExact("w", w, R["site/js/core/wallet.js"]).text, `(await import("enclave-addon:hard-nav")).navigate("checkout", { push: true });`);
});

// ---- config: null by default, no synthesis, no silent legacy endpoints ----
test("disabled config keeps FUNDING_* null and changes nothing", () => {
  assert.deepEqual(L.configReplacements(nullCfg()), []);
  const tpl = JSON.parse(fs.readFileSync(path.join(HERE, "..", "config.template.json"), "utf8"));
  assert.deepEqual(L.configReplacements(tpl), []);
});
test("config refusals", () => {
  const c1 = nullCfg(); delete c1.funding.FUNDING_MIGRATION_APPROVAL;
  assert.throws(() => L.validateConfig(c1), /exactly/);
  const c2 = nullCfg(); c2.funding.FUNDING_RUNTIME = { schema: "enclave-funding-browser-runtime-r1" };
  assert.throws(() => L.validateConfig(c2), /disabled release keeps/);
  const c3 = { ...nullCfg(), release: "enabled", reviewed: true };
  assert.throws(() => L.validateConfig(c3), /concrete FUNDING_RUNTIME/);
  const c4 = { ...nullCfg(), release: "enabled", reviewed: true };
  c4.funding = { FUNDING_RUNTIME: { schema: "enclave-funding-browser-runtime-r1" }, FUNDING_MIGRATION_PROPOSAL: null,
    FUNDING_MIGRATION_APPROVAL: { schema: "enclave-funding-migration-approval-r1", rootReviewed: true } };
  assert.throws(() => L.validateConfig(c4), /together with its proposal/);
  c4.funding.FUNDING_MIGRATION_PROPOSAL = { schema: "enclave-funding-migration-proposal-r1" };
  c4.funding.FUNDING_MIGRATION_APPROVAL.rootReviewed = false;
  assert.throws(() => L.validateConfig(c4), /rootReviewed/);
  assert.throws(() => L.validateConfig({ ...nullCfg(), extra: 1 }), /unknown key/);
  assert.throws(() => L.validateConfig({ ...nullCfg(), overrides: [{ literal: "https://a.example", value: "http://b.example", reason: "x" }] }), /https/);
  assert.throws(() => L.validateConfig({ ...nullCfg(), release: "enabled", reviewed: false }), /reviewed: true/);
});
test("enabled config replaces only the supplied FUNDING_* values, exactly", () => {
  const cfg = { ...nullCfg(), release: "enabled", reviewed: true };
  cfg.funding.FUNDING_RUNTIME = { schema: "enclave-funding-browser-runtime-r1", vault: "0x1" };
  const text = `export const FUNDING_RUNTIME = null;   // a\nexport const FUNDING_MIGRATION_PROPOSAL = null;\nexport const FUNDING_MIGRATION_APPROVAL = null;\n`;
  const r = L.applyExact("config", text, L.configReplacements(cfg));
  assert.match(r.text, /^export const FUNDING_RUNTIME = \{"schema":"enclave-funding-browser-runtime-r1","vault":"0x1"\};   \/\/ a$/m);
  assert.match(r.text, /FUNDING_MIGRATION_PROPOSAL = null;/);
  assert.match(r.text, /FUNDING_MIGRATION_APPROVAL = null;/);
});
test("legacy config literals must be in live evidence, accepted, or overridden", () => {
  const text = `export const A = "https://api.example/v1"; // "not https://x"\nexport let B = "0x18419CA2b502d423a8de6269aeee171a378626e3";`;
  assert.deepEqual(L.configLiterals(text), ["https://api.example/v1", "0x18419CA2b502d423a8de6269aeee171a378626e3"]);
  assert.throws(() => L.checkConfigLiterals(text, "", nullCfg()), /https:\/\/api\.example\/v1/);
  const live = `x="0x18419ca2b502d423a8de6269aeee171a378626e3"`;
  assert.throws(() => L.checkConfigLiterals(text, live, nullCfg()), /api\.example/);
  const acc = { ...nullCfg(), acceptLegacy: ["https://api.example/v1"] };
  assert.deepEqual(L.checkConfigLiterals(text, live, acc).map((r) => r.status), ["root-accepted", "in-live"]);
  const ov = { ...nullCfg(), overrides: [{ literal: "https://api.example/v1", value: "https://api2.example/v1", reason: "peer config" }] };
  assert.equal(L.checkConfigLiterals(text, live, ov)[0].status, "overridden");
  const stray = { ...nullCfg(), overrides: [{ literal: "https://nowhere.example", value: "https://b.example", reason: "r" }] };
  assert.throws(() => L.checkConfigLiterals(text, live + "https://api.example/v1", stray), /not a config\.js literal/);
});

// ---- additions only: collisions / traversal / symlinks ----
test("planAdditions refuses collisions, traversal, duplicates and file/dir clashes", () => {
  const ex = L.parseExistingPaths("index.html\n/js/boot.js\nvendor/sessions.js\nFunding.html\njs/funding-r2\n");
  const ok = [{ path: "vendor/sessions.funding-r2.9dda76f6aaaaaaaa.js" }];
  assert.equal(L.planAdditions(ok, ex), ok);
  assert.throws(() => L.planAdditions([{ path: "funding.html" }], ex), /collides/);                // case-insensitive
  assert.throws(() => L.planAdditions([{ path: "vendor/sessions.js" }], ex), /collides/);
  assert.throws(() => L.planAdditions([{ path: "js/funding-r2/funding.x.js" }], ex), /existing file/);
  assert.throws(() => L.planAdditions([{ path: "js" }], ex), /collides/);
  for (const p of ["../x.js", "a/../b.js", "/abs.js", "a//b.js", ".hidden", "A.js"]) assert.throws(() => L.planAdditions([{ path: p }], ex), /refused/);
  assert.throws(() => L.planAdditions([{ path: "a.js" }, { path: "a.js" }], ex), /duplicate/);
  assert.throws(() => L.parseExistingPaths("a/../b\n"), /bad entry/);
});
test("readRegular refuses symlinks and symlinked directories", () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fa-sym-")));
  fs.writeFileSync(path.join(d, "f.js"), "x");
  fs.symlinkSync(path.join(d, "f.js"), path.join(d, "l.js"));
  fs.mkdirSync(path.join(d, "real"));
  fs.writeFileSync(path.join(d, "real", "g.js"), "y");
  fs.symlinkSync(path.join(d, "real"), path.join(d, "dirlink"));
  assert.equal(L.readRegular(path.join(d, "f.js")).toString(), "x");
  assert.throws(() => L.readRegular(path.join(d, "l.js")), /symlink refused/);
  assert.throws(() => L.readRegular(path.join(d, "dirlink", "g.js")), /through a symlink/);
});

// ---- import closure / externals ----
test("closure requires the funding graph and refuses router, other pages, tests", () => {
  const base = [...L.REQUIRED_INPUTS, "site/js/core/chain.js", "site/js/lib/enclave-element.js", "sdk/funding/x.js"];
  assert.deepEqual(L.checkClosure(base), base);
  assert.throws(() => L.checkClosure(base.filter((r) => r !== "site/components/wallet-button/wallet-button.js")), /lacks/);
  for (const bad of ["site/js/boot.js", "site/js/pages/dashboard.js", "site/js/router.js", "site/js/core/__tests__/x.js",
    "site/js/core/x.test.js", "test/fixtures/signer.js", "scripts/build-site.mjs", "addon:src/other.js"])
    assert.throws(() => L.checkClosure([...base, bad]), /refused inputs/, bad);
});
test("externals: only versioned SDKs or unchanged listed global vendors", () => {
  const existing = new Set(["vendor/webauthn.js", "vendor/sessions.js", "vendor/funding.js"]);
  const versioned = ["/vendor/sessions.funding-r2.9dda76f6.js", "/vendor/funding.funding-r2.ab.js"];
  assert.deepEqual(L.checkExternals([...versioned, "/vendor/webauthn.js"], { versioned, existing }).length, 3);
  for (const bad of ["/vendor/sessions.js", "/vendor/funding.js", "/vendor/walletconnect.js", "https://esm.sh/x", "/js/boot.js"])
    assert.throws(() => L.checkExternals([bad], { versioned, existing }), /not allowed/, bad);
  assert.deepEqual(L.vendorRefs(`a("/vendor/x.js");b='/vendor/y.js'`), ["/vendor/x.js", "/vendor/y.js"]);
  assert.deepEqual(L.vendorImportSpecifiers(`import{a as b}from"./c.js";import("/vendor/d.js");import"e";x.from("f")`),
    ["./c.js", "/vendor/d.js", "e"]);
});

// ---- standalone document ----
const PAGE = `<!DOCTYPE html>
<html><head>
<script>
(function(){ document.documentElement.classList.add("x"); })();
</script>
<link rel="stylesheet" href="css/site.css" />
<script type="module" blocking="render" src="js/boot.js"></script>
<script type="application/ld+json">{"a":1}</script>
</head><body>
<c-header current=""></c-header>
<c-section-head eyebrow="Funding" heading="Gas"><p>slot</p></c-section-head>
<c-footer></c-footer><c-toast></c-toast>
</body></html>`;
const TPL = {
  header: `<nav><a data-view="dashboard" href="dashboard">Dash</a><a href="sessions">S</a></nav><c-wallet-button></c-wallet-button>`,
  "wallet-button": `<button id="walletBtn">Sign in →</button>`,
  "section-head": `<p>{eyebrow}</p><h2>{heading}</h2><slot></slot>`,
  footer: `<footer><a href="terms">T</a><span data-build>dev</span></footer>`,
};
test("transformHtml: exact head edits, no inline script, components baked + nested", () => {
  const r = L.transformHtml(PAGE, { tpl: (n) => TPL[n] ?? null, cssHref: "css/site.funding-r2.aa.css", moduleHref: "js/funding-r2/funding.bb.js", stamp: "funding-r2 · bb" });
  assert.match(r.html, /<link rel="stylesheet" href="css\/site\.funding-r2\.aa\.css" \/>/);
  assert.match(r.html, /<script type="module" src="js\/funding-r2\/funding\.bb\.js"><\/script>/);
  assert.equal(L.inlineScripts(r.html).length, 0);
  assert.equal(r.removedInlineScripts.length, 1);
  assert.match(r.removedInlineScripts[0].csp, /^'sha256-/);
  assert.ok(!r.html.includes("boot.js") && !r.html.includes("blocking"));
  assert.match(r.html, /<c-header current="" data-ssr><nav>/);
  assert.match(r.html, /<c-wallet-button data-ssr><button id="walletBtn">/);
  assert.match(r.html, /<p>Funding<\/p><h2>Gas<\/h2><p>slot<\/p>/);
  assert.match(r.html, /<span data-build>funding-r2 · bb<\/span>/);
  assert.deepEqual(r.unbaked, ["toast"]);
  assert.deepEqual(L.localRefs(r.html), ["css/site.funding-r2.aa.css", "dashboard", "js/funding-r2/funding.bb.js", "sessions", "terms"]);
  const live = L.transformHtml(PAGE, { tpl: (n) => TPL[n] ?? null, cssHref: "x", moduleHref: "m.js", keepCss: true });
  assert.match(live.html, /href="css\/site\.css"/);
  assert.throws(() => L.transformHtml(PAGE.replace(' blocking="render"', ""), { tpl: () => null, cssHref: "a", moduleHref: "b" }), /found 0/);
});
test("existsIn: pretty URLs, .html, directory index; no traversal", () => {
  const s = new Set(["index.html", "dashboard.html", "apps/index.html", "favicon.ico"]);
  for (const ok of ["dashboard", "/dashboard", "./dashboard?x=1", "apps/", "apps", "", "/", "favicon.ico", "dashboard#a"]) assert.ok(L.existsIn(ok, s), ok);
  for (const no of ["sessions", "../dashboard", "apps/../dashboard"]) assert.ok(!L.existsIn(no, s), no);
});
test("inlineTemplate inlines the paired template, refuses unexpected shapes", () => {
  const src = `class W extends E {\n  static templateUrl = new URL("./w.html", import.meta.url);\n}`;
  assert.equal(L.inlineTemplate("w", src, () => "<b>\"x\"</b>"), `class W extends E {\n  static _tpl = "<b>\\"x\\"</b>";\n}`);
  assert.throws(() => L.inlineTemplate("w", `static templateUrl = new URL('./w.html', import.meta.url);`, () => ""), /not inlined/);
});
test("css references resolve inside the site", () => {
  assert.deepEqual(L.cssRefs(`a{b:url(../assets/f.woff2)} c{d:url("data:x")} @import "x.css";`), ["../assets/f.woff2", "x.css"]);
  assert.equal(L.cssRefPath("../assets/f.woff2"), "assets/f.woff2");
  assert.equal(L.cssRefPath("/assets/f.woff2?v=1"), "assets/f.woff2");
  assert.throws(() => L.cssRefPath("../../etc/passwd"), /escapes/);
});

// ---- init lifecycle + navigation ----
test("entry boots the page once and imports only the two addon sentinels", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "src", "entry.js"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  assert.deepEqual(src.split("\n").map((l) => l.trim()).filter(Boolean), [
    `import { boot } from "${L.FUNDING_PAGE}";`, `import "${L.WALLET_BUTTON}";`, "boot();"]);
});
test("hard-nav: full document load of an existing page; unknown views refused", async () => {
  const calls = [];
  globalThis.document = { baseURI: "https://enclave.host/funding" };
  globalThis.location = { assign: (u) => calls.push(u) };
  try {
    const { navigate, VIEWS } = await import("../src/hard-nav.js");
    assert.deepEqual([...VIEWS], ["dashboard", "checkout"]);
    navigate("dashboard", { push: true });
    navigate("checkout", { push: true });
    assert.deepEqual(calls, ["https://enclave.host/dashboard", "https://enclave.host/checkout"]);
    assert.throws(() => navigate("https://evil.example/"), /No page/);
    assert.throws(() => navigate("../admin"), /No page/);
  } finally { delete globalThis.document; delete globalThis.location; }
});

// ---- pins ----
test("pins: null / unreviewed / non-qualified sessions SDK refused", () => {
  const h = "a".repeat(64);
  const good = { schema: L.PINS_SCHEMA, reviewed: true, esbuildVersion: "0.25.0", config: h, existingPaths: h, liveInventory: h,
    liveSessionsVendor: h, inputs: { "site/vendor/sessions.js": "9dda76f6" + "0".repeat(56) } };
  assert.equal(L.validatePins(good), good);
  assert.throws(() => L.validatePins({ ...good, reviewed: false }), /reviewed/);
  assert.throws(() => L.validatePins({ ...good, config: null }), /config/);
  assert.throws(() => L.validatePins({ ...good, inputs: { ...good.inputs, x: null } }), /input x/);
  assert.throws(() => L.validatePins({ ...good, inputs: { "site/vendor/sessions.js": h } }), /qualified/);
  const tpl = JSON.parse(fs.readFileSync(path.join(HERE, "..", "pins.template.json"), "utf8"));
  assert.throws(() => L.validatePins(tpl));
});
