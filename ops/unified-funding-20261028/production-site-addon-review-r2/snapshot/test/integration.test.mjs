// End-to-end: real source checkout + real esbuild + live public evidence, into a temp dir only.
// Skips when the source checkout, its esbuild, or the live evidence is not present on this machine.
// The existing-paths list here is SYNTHETIC (derived from the page's own links); the release uses the CID listing.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import * as L from "../lib.mjs";
import { run, DEFAULTS } from "../build.mjs";

const SOURCE = DEFAULTS.source, LIVE = DEFAULTS.live;
let skip = false;
try { createRequire(path.join(SOURCE, "package.json")).resolve("esbuild"); fs.statSync(path.join(LIVE, "inventory.json")); }
catch (e) { skip = `source/esbuild/live evidence unavailable (${e.message})`; }

const hashTree = (files) => Object.fromEntries(files.map((f) => [f, L.sha256(fs.readFileSync(f))]));

test("addon build: additions only, pinned, closed, reversible, null config", { skip }, async () => {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "funding-addon-")));
  const site = path.join(SOURCE, "site");
  const css = fs.existsSync(path.join(site, "css/site.css")) ? "source" : "live";

  // test-only config: every legacy literal explicitly accepted (the refusal itself is unit-tested)
  const cfg = JSON.parse(fs.readFileSync(new URL("../config.template.json", import.meta.url), "utf8"));
  cfg.acceptLegacy = L.configLiterals(fs.readFileSync(path.join(site, "js/core/config.js"), "utf8"));
  fs.writeFileSync(path.join(T, "config.json"), JSON.stringify(cfg));

  // synthetic existing tree: the page's own links + live modules + global vendors (never funding.html)
  const tpl = (n) => { const f = path.join(site, "components", n, n + ".html"); return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null; };
  const baked = L.bake(fs.readFileSync(path.join(site, "funding.html"), "utf8"), tpl);
  const ex = new Set(["index.html", "dashboard.html", "checkout.html", "sessions.html", "css/site.css", "js/boot.js",
    "vendor/sessions.js", "vendor/webauthn.js", "vendor/walletconnect.js", "favicon.ico"]);
  for (const r of L.localRefs(baked)) {
    const p = r.split(/[?#]/)[0].replace(/^\.\//, "").replace(/^\/+/, "");
    if (!/^funding(\.html)?$/.test(p)) ex.add(p === "" || p.endsWith("/") ? p + "index.html" : p);
  }
  if (css === "source") for (const r of L.cssRefs(fs.readFileSync(path.join(site, "css/site.css"), "utf8"))) ex.add(L.cssRefPath(r));
  const inv = JSON.parse(fs.readFileSync(path.join(LIVE, "inventory.json"), "utf8"));
  for (const u of Object.keys({ ...inv.modules, ...inv.sessionModuleInspection })) ex.add(u.replace(/^\//, ""));
  fs.writeFileSync(path.join(T, "existing.txt"), [...ex].sort().join("\n") + "\n");
  const common = { config: path.join(T, "config.json"), existingPaths: path.join(T, "existing.txt"), css };

  // propose -> review -> build
  const p = await run({ mode: "propose", pinsOut: path.join(T, "pins.proposed.json"), ...common });
  const pins = { ...p.proposal, reviewed: true };
  fs.writeFileSync(path.join(T, "pins.json"), JSON.stringify(pins));
  const protectedFiles = [...Object.keys(pins.inputs).filter((k) => !k.startsWith("addon:")).map((k) => path.join(SOURCE, k)),
    ...L.jsFilesUnder(LIVE), path.join(LIVE, "inventory.json")];
  const before = hashTree(protectedFiles);
  const out = path.join(T, "out");
  const { manifest: m } = await run({ mode: "build", pins: path.join(T, "pins.json"), out, ...common });

  // preservation: no source / live evidence byte changed; additions never shadow an existing path
  assert.deepEqual(hashTree(protectedFiles), before);
  for (const a of m.additions) assert.ok(!ex.has(a.path), a.path);
  const written = fs.readdirSync(path.join(out, "site-additions"), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => path.relative(path.join(out, "site-additions"), path.join(e.parentPath ?? e.path, e.name))).sort();
  assert.deepEqual(written, m.additions.map((a) => a.path).sort());
  for (const line of fs.readFileSync(path.join(out, "ADDITIONS.sha256"), "utf8").trim().split("\n")) {
    const [h, rel] = line.split("  ");
    assert.equal(L.sha256(fs.readFileSync(path.join(out, "site-additions", rel))), h);
  }

  // versioned SDKs: exact pinned bytes, legacy sessions SDK separate from the live global one
  assert.ok(m.vendor.sessions.sha256.startsWith(L.LEGACY_SESSIONS_PREFIX));
  assert.equal(m.vendor.sessions.liveGlobalSha256, "b61255778aa3a901b2a0807642c37e9e1b8ce5951e8190c17fcbd6bde05008e9");
  assert.ok(fs.readFileSync(path.join(out, "site-additions", m.vendor.sessions.path)).equals(fs.readFileSync(path.join(site, "vendor/sessions.js"))));
  assert.ok(fs.readFileSync(path.join(out, "site-additions", m.vendor.funding.path)).equals(fs.readFileSync(path.join(site, "vendor/funding.js"))));

  // import closure + path replacements (reverse-equal), no router, no unversioned SDK
  for (const r of L.REQUIRED_INPUTS) assert.ok(m.moduleClosure.includes(r), r);
  assert.ok(!m.moduleClosure.some((r) => /boot\.js$|pages\/(?!funding\.js)/.test(r)));
  assert.deepEqual(Object.keys(m.replacements).sort(), ["site/components/wallet-button/wallet-button.js", "site/js/core/sessions.js",
    "site/js/core/wallet.js", "site/js/pages/funding.js"]);
  for (const [rel, r] of Object.entries(m.replacements)) {
    assert.equal(r.reverseEqual, true, rel);
    let fwd = fs.readFileSync(path.join(SOURCE, rel), "utf8");
    for (const { from, to } of r.pairs) fwd = fwd.replace(from, () => to);
    assert.equal(L.sha256(fwd), r.replacedSha256, rel);
  }
  const jsRel = m.additions.find((a) => a.path.startsWith("js/")).path;
  const bundle = fs.readFileSync(path.join(out, "site-additions", jsRel), "utf8");
  assert.ok(bundle.includes("/" + m.vendor.sessions.path) && bundle.includes("/" + m.vendor.funding.path));
  assert.ok(!/["'`]\/vendor\/(sessions|funding)\.js["'`]/.test(bundle));
  assert.ok(!bundle.includes("enclave-addon:"));
  assert.ok(bundle.includes("c-wallet-button"));
  // The shared base class retains templateUrl=null and its fallback loader.
  // Every concrete component URL must have been replaced by its baked template.
  assert.ok(!/templateUrl\s*=\s*new URL/.test(bundle));
  assert.ok(!/new URL\(["\']\.\/[^"\']+\.html/.test(bundle));

  // config: null FUNDING_*, config.js untouched
  assert.deepEqual(m.config.funding, { FUNDING_RUNTIME: null, FUNDING_MIGRATION_PROPOSAL: null, FUNDING_MIGRATION_APPROVAL: null });
  assert.ok(!("site/js/core/config.js" in m.replacements));

  // document: standalone, no inline script, baked wallet control, own module + css
  const html = fs.readFileSync(path.join(out, "site-additions", "funding.html"), "utf8");
  assert.ok(html.includes(`<script type="module" src="${jsRel}"></script>`));
  assert.ok(!html.includes("boot.js"));
  assert.equal(L.inlineScripts(html).length, 0);
  assert.match(html, /<c-wallet-button[^>]*data-ssr>/);
  assert.match(html, /id="fdBody"/);
  if (css === "source") assert.ok(html.includes(`href="${m.css.path}"`));

  // refusals: re-run into the same dir, tampered pin, unreviewed pins, collision with an existing path
  await assert.rejects(run({ mode: "build", pins: path.join(T, "pins.json"), out, ...common }), /EEXIST/);
  fs.writeFileSync(path.join(T, "pins.bad.json"), JSON.stringify({ ...pins, inputs: { ...pins.inputs, "site/js/pages/funding.js": "0".repeat(64) } }));
  await assert.rejects(run({ mode: "build", pins: path.join(T, "pins.bad.json"), out: path.join(T, "o2"), ...common }), /site\/js\/pages\/funding\.js/);
  await assert.rejects(run({ mode: "build", pins: path.join(T, "pins.proposed.json"), out: path.join(T, "o3"), ...common }), /reviewed/);
  fs.writeFileSync(path.join(T, "existing2.txt"), [...ex, "funding.html"].join("\n"));
  await assert.rejects(run({ mode: "propose", pinsOut: path.join(T, "p2.json"), ...common, existingPaths: path.join(T, "existing2.txt") }), /collides/);
  for (const d of ["o2", "o3"]) assert.ok(!fs.existsSync(path.join(T, d)));
});
