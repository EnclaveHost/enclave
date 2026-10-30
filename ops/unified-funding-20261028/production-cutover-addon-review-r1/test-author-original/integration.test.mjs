// End-to-end: overlay -> propose -> review -> build with real esbuild (from --deps), live evidence and the real
// 1126-path existing listing, into a temp dir only. Compares with the qualified r2 disabled artifact.
// Skips when deps/esbuild, live evidence, candidate or the r2 artifact is not present on this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as L from "../lib.mjs";
import { run, DEFAULTS, ADDON_R2 } from "../build.mjs";
import { makeOverlay, DEFAULTS as OV, BASELINE, CANDIDATE, CONFIG } from "../make-overlay.mjs";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const R2_ART = path.join(ADDON_R2, "artifact-disabled-r1");
const EXISTING = path.join(ADDON_R2, "existing-live-paths.txt");
let skip = false;
try {
  createRequire(path.join(DEFAULTS.deps, "package.json")).resolve("esbuild");
  for (const f of [path.join(DEFAULTS.live, "inventory.json"), path.join(OV.candidate, "site/vendor/funding.js"), path.join(R2_ART, "MANIFEST.json"), EXISTING]) fs.statSync(f);
} catch (e) { skip = `deps/esbuild, live evidence, candidate or r2 artifact unavailable (${e.message})`; }

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const hashAll = (files) => Object.fromEntries(files.map((f) => [f, L.sha256(fs.readFileSync(f))]));

test("disabled cutover addon: additive, pinned, exact candidate SDK, r2 document preserved, nothing old mutated", { skip }, async () => {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "funding-cutover-addon-")));
  const protectedFiles = [
    ...[...Object.keys(BASELINE), CONFIG.path].map((r) => path.join(OV.source, r)),
    ...Object.keys(CANDIDATE).map((r) => path.join(OV.candidate, r)),
    ...walk(path.join(ADDON_R2, "src")), path.join(ADDON_R2, "lib.mjs"), path.join(ADDON_R2, "build.mjs"), EXISTING, ...walk(R2_ART),
    ...L.jsFilesUnder(DEFAULTS.live), path.join(DEFAULTS.live, "inventory.json"),
  ];
  const before = hashAll(protectedFiles);

  const OVERLAY = path.join(T, "overlay");
  const ov = makeOverlay({ out: OVERLAY });
  const common = { source: OVERLAY, config: path.join(HERE, "config-disabled-cutover-r1.json"), existingPaths: EXISTING };

  // the whole old source is refused as --source (not the tested page, no five null exports); nothing written
  await assert.rejects(run({ mode: "propose", pinsOut: path.join(T, "old.json"), ...common, source: DEFAULTS.deps }), /qualified\/tested|FUNDING_/);
  assert.equal(fs.existsSync(path.join(T, "old.json")), false);
  // the r2 reviewed pins are not reused
  await assert.rejects(run({ mode: "build", pins: path.join(ADDON_R2, "pins-disabled-reviewed-r1.json"), out: path.join(T, "r2pins"), ...common }), /version|qualified/);
  assert.equal(fs.existsSync(path.join(T, "r2pins")), false);

  const p = await run({ mode: "propose", pinsOut: path.join(T, "pins.proposed.json"), ...common });
  assert.equal(p.proposal.reviewed, false); assert.equal(p.proposal.version, L.VERSION);
  const pinsFile = path.join(T, "pins.json");
  fs.writeFileSync(pinsFile, JSON.stringify({ ...p.proposal, reviewed: true }));
  const r = await run({ mode: "build", pins: pinsFile, out: path.join(T, "art"), ...common });
  await assert.rejects(run({ mode: "build", pins: pinsFile, out: path.join(T, "art"), ...common }), /EEXIST/);
  const m = r.manifest;

  // format the composite consumes, this version, every input pinned
  assert.equal(m.schema, "enclave-funding-addon-manifest-r2"); assert.equal(m.version, "funding-cutover-r1"); assert.equal(m.mode, "build");
  assert.deepEqual(Object.keys(m.pins).sort(), ["config", "existingPaths", "liveInventory", "liveSessionsVendor"]);
  assert.deepEqual(m.inputs, p.proposal.inputs);
  for (const [k, v] of Object.entries(L.QUALIFIED)) assert.equal(m.inputs[k], v, k);
  for (const [k, v] of Object.entries(BASELINE)) assert.equal(m.inputs[k], v, k);
  assert.equal(m.inputs[CONFIG.path], ov.manifest.files.find((f) => f.path === CONFIG.path).outputSha256);
  assert.notEqual(m.inputs[CONFIG.path], CONFIG.sha256);

  // additive only: exactly the 4 top entries, 5 new versioned files, no collision with the 1126 existing paths
  assert.deepEqual(fs.readdirSync(r.out).sort(), ["ADDITIONS.json", "ADDITIONS.sha256", "MANIFEST.json", "site-additions"]);
  const existing = L.parseExistingPaths(fs.readFileSync(EXISTING, "utf8"));
  assert.equal(m.additions.length, 5);
  for (const a of m.additions) {
    assert.ok(a.path === "funding.html" || a.path.includes("funding-cutover-r1"), a.path);
    assert.ok(!existing.has(a.path), a.path);
    assert.equal(L.sha256(fs.readFileSync(path.join(r.out, "site-additions", a.path))), a.sha256);
  }
  assert.equal(walk(path.join(r.out, "site-additions")).length, 5);

  // exact versioned new SDK; legacy sessions SDK byte-identical; no r2 or unversioned SDK reference
  const fv = m.additions.find((a) => a.path.startsWith("vendor/funding."));
  assert.equal(fv.path, `vendor/funding.funding-cutover-r1.${L.QUALIFIED["site/vendor/funding.js"].slice(0, 16)}.js`);
  assert.equal(fv.sha256, L.QUALIFIED["site/vendor/funding.js"]);
  assert.equal(m.additions.find((a) => a.path.startsWith("vendor/sessions.")).sha256, L.QUALIFIED["site/vendor/sessions.js"]);
  const js = m.additions.find((a) => a.path.startsWith("js/"));
  const bundle = fs.readFileSync(path.join(r.out, "site-additions", js.path), "utf8");
  assert.ok(bundle.includes("/" + fv.path));
  assert.ok(!bundle.includes("funding-r2"));
  assert.ok(!/["'`]\/vendor\/(sessions|funding)\.js["'`]/.test(bundle));

  // disabled: all five null, nothing in config.js replaced, approval note recorded, no human approval asserted
  assert.equal(m.config.release, "disabled");
  assert.deepEqual(m.config.funding, Object.fromEntries(L.FUNDING_KEYS.map((k) => [k, null])));
  assert.deepEqual(m.config.nullExports, L.FUNDING_KEYS);
  assert.equal(m.config.humanApproval, null);
  assert.equal(m.replacements[CONFIG.path], undefined);

  // old build behavior preserved: same closure, replacements, literals, document (modulo versioned names)
  const r2m = JSON.parse(fs.readFileSync(path.join(R2_ART, "MANIFEST.json"), "utf8"));
  assert.deepEqual(m.moduleClosure, r2m.moduleClosure);
  assert.deepEqual(Object.keys(m.replacements).sort(), Object.keys(r2m.replacements).sort());
  for (const v of Object.values(m.replacements)) assert.equal(v.reverseEqual, true);
  assert.deepEqual(m.config.literals, r2m.config.literals);
  assert.deepEqual(m.html.unbakedTags, r2m.html.unbakedTags);
  assert.deepEqual(m.html.removedInlineScripts, r2m.html.removedInlineScripts);
  assert.deepEqual(m.externals.filter((e) => !e.includes("funding-")), r2m.externals.filter((e) => !e.includes("funding-")));
  const r2js = r2m.additions.find((a) => a.path.startsWith("js/")), r2css = r2m.additions.find((a) => a.path.startsWith("css/"));
  const css = m.additions.find((a) => a.path.startsWith("css/"));
  assert.equal(css.sha256, r2css.sha256);
  const mapped = fs.readFileSync(path.join(R2_ART, "site-additions", "funding.html"), "utf8")
    .split(r2js.path).join(js.path).split(r2css.path).join(css.path)
    .split(`funding-r2 · ${r2js.sha256.slice(0, 8)}`).join(`${L.VERSION} · ${js.sha256.slice(0, 8)}`);
  assert.equal(fs.readFileSync(path.join(r.out, "site-additions", "funding.html"), "utf8"), mapped);

  // no old file mutations (source baseline, candidate, r2 addon + artifact, existing listing, live evidence)
  assert.deepEqual(hashAll(protectedFiles), before);
});
