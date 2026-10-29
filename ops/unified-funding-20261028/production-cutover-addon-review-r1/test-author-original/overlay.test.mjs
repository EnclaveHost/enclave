// Overlay from the real source baseline + tested candidate, into a temp dir only. Skips if either tree is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as L from "../lib.mjs";
import { makeOverlay, DEFAULTS, BASELINE, CANDIDATE, CONFIG, CONFIG_PATCH } from "../make-overlay.mjs";

let skip = false;
try { fs.statSync(path.join(DEFAULTS.source, CONFIG.path)); fs.statSync(path.join(DEFAULTS.candidate, "site/vendor/funding.js")); }
catch (e) { skip = `source/candidate unavailable (${e.message})`; }

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(d, e.name);
  if (e.isSymbolicLink()) throw new Error("symlink in overlay: " + p);
  return e.isDirectory() ? walk(p) : [p];
});

test("overlay: exactly the pinned files, originals untouched, one reversible config patch", { skip }, () => {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "funding-cutover-overlay-")));
  const originals = [...Object.keys(BASELINE).map((r) => path.join(DEFAULTS.source, r)), path.join(DEFAULTS.source, CONFIG.path),
    ...Object.keys(CANDIDATE).map((r) => path.join(DEFAULTS.candidate, r))];
  const before = originals.map((f) => L.sha256(fs.readFileSync(f)));

  // refusals happen before any write
  assert.throws(() => makeOverlay({ out: path.join(DEFAULTS.source, "overlay-must-not-exist") }), /protected tree/);
  assert.equal(fs.existsSync(path.join(DEFAULTS.source, "overlay-must-not-exist")), false);
  fs.mkdirSync(path.join(T, "taken"));
  assert.throws(() => makeOverlay({ out: path.join(T, "taken") }), /exists/);
  assert.deepEqual(fs.readdirSync(path.join(T, "taken")), []);

  const OUT = path.join(T, "overlay");
  const { manifest } = makeOverlay({ out: OUT });
  assert.throws(() => makeOverlay({ out: OUT }), /exists/);

  const rels = walk(OUT).map((f) => path.relative(OUT, f).split(path.sep).join("/")).sort();
  assert.deepEqual(rels, [...Object.keys(BASELINE), ...Object.keys(CANDIDATE), CONFIG.path, "OVERLAY-MANIFEST.json"].sort());
  assert.ok(!rels.some((r) => /package\.json|node_modules|boot\.js|scripts\//.test(r)));
  for (const [rel, sha] of Object.entries({ ...BASELINE, ...Object.fromEntries(Object.entries(CANDIDATE).filter(([, v]) => v)) }))
    assert.equal(L.sha256(fs.readFileSync(path.join(OUT, rel))), sha, rel);

  const outCfg = fs.readFileSync(path.join(OUT, CONFIG.path), "utf8");
  assert.deepEqual(L.checkNullExports(outCfg), L.FUNDING_KEYS);
  const [[from, to]] = CONFIG_PATCH;
  assert.equal(L.sha256(Buffer.from(outCfg.replace(to, () => from), "utf8")), CONFIG.sha256);   // reverse patch = original bytes
  const rec = manifest.files.find((f) => f.path === CONFIG.path);
  assert.equal(rec.kind, "patched"); assert.equal(rec.reverseEqual, true);
  assert.equal(rec.originalSha256, CONFIG.sha256); assert.equal(rec.outputSha256, L.sha256(Buffer.from(outCfg, "utf8")));
  assert.equal(Object.keys(manifest.candidateCoreVerifiedInPlace).length, 8);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(OUT, "OVERLAY-MANIFEST.json"), "utf8")), JSON.parse(JSON.stringify(manifest)));

  assert.deepEqual(originals.map((f) => L.sha256(fs.readFileSync(f))), before);
});
