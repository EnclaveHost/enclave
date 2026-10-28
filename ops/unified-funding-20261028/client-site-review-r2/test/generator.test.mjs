// UNREVIEWED, NOT RUN. Executes generator/generate.py (python3) in an ISOLATED temporary layout built from copies of the
// REAL pinned inputs (r4 core, client-r1 codec, this stage's authored files, and the source checkout's site files).
// It never writes outside the temporary directory. Skips (does not pass) when python3 or an input is unavailable.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const UF = path.dirname(HERE);
const STAGE = path.basename(HERE);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const pinsTemplate = JSON.parse(fs.readFileSync(path.join(HERE, "generated", "SOURCE-PINS.json"), "utf8"));
const inputs = Object.keys(pinsTemplate.inputs);
const python = (() => { try { execFileSync("python3", ["--version"]); return "python3"; } catch { return null; } })();
const missing = inputs.filter((rel) => !fs.existsSync(path.join(UF, rel)));
const skip = !python ? "python3 unavailable" : missing.length ? `inputs missing: ${missing.join(", ")}` : false;

/** tmp/source/... + tmp/uf/{client-repair-r4,client-r1,<stage>}/...; pins computed from the copies (+ optional tweak). */
function layout(tweak = () => {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "funding-gen-"));
  const uf = path.join(tmp, "uf");
  const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); };
  for (const rel of inputs) copy(path.join(UF, rel), path.join(uf, rel));
  copy(path.join(HERE, "generator", "generate.py"), path.join(uf, STAGE, "generator", "generate.py"));
  const pins = { ...pinsTemplate, inputs: Object.fromEntries(inputs.map((rel) => [rel, sha(fs.readFileSync(path.join(uf, rel)))])) };
  const ctx = { tmp, uf, stage: path.join(uf, STAGE), pins };
  tweak(ctx);
  fs.mkdirSync(path.join(ctx.stage, "generated"), { recursive: true });
  fs.writeFileSync(path.join(ctx.stage, "generated", "SOURCE-PINS.json"), JSON.stringify(ctx.pins, null, 2));
  return ctx;
}
const run = (ctx) => spawnSync(python, [path.join(ctx.stage, "generator", "generate.py")], { encoding: "utf8" });
/** true when `big` is `small` with characters INSERTED only (nothing removed or changed). */
function insertOnly(small, big) {
  let i = 0;
  for (let j = 0; j < big.length && i < small.length; j += 1) if (big[j] === small[i]) i += 1;
  return i === small.length;
}

test("generator runs on the real pinned inputs and produces an exact, insert/append-only candidate", { skip }, () => {
  const ctx = layout();
  const r = run(ctx);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const cand = path.join(ctx.stage, "candidate");
  const man = JSON.parse(fs.readFileSync(path.join(cand, "INSTALL-MANIFEST.json"), "utf8"));
  for (const [p, e] of Object.entries(man.outputs)) assert.equal(sha(fs.readFileSync(path.join(cand, p))), e.sha256, p);
  // core: only the import specifiers changed, and reversing them gives the pinned bytes
  const rev = { "util.mjs": [["\"viem\"", "\"../../../source/node_modules/viem/_esm/index.js\""]], "chain-proof.mjs": [["\"viem\"", "\"../../../source/node_modules/viem/_esm/index.js\""]],
    "v2-store.mjs": [["\"viem\"", "\"../../../source/node_modules/viem/_esm/index.js\""], ["\"./funding-codec.mjs\"", "\"../../client-r1/funding-codec.mjs\""]],
    "funding-client.mjs": [["\"viem\"", "\"../../../source/node_modules/viem/_esm/index.js\""], ["\"./funding-codec.mjs\"", "\"../../client-r1/funding-codec.mjs\""]],
    "migration.mjs": [["\"viem\"", "\"../../../source/node_modules/viem/_esm/index.js\""], ["\"./funding-codec.mjs\"", "\"../../client-r1/funding-codec.mjs\""]],
    "browser-entry.mjs": [], "funding-codec.mjs": [["\"viem\"", "\"../../source/node_modules/viem/_esm/index.js\""]] };
  const from = { "funding-codec.mjs": "client-r1/funding-codec.mjs" };
  for (const [name, pairs] of Object.entries(rev)) {
    let t = fs.readFileSync(path.join(cand, "sdk", "funding", name), "utf8");
    assert.doesNotMatch(t, /(from|import)\s*\(?\s*["']\.\.\//, `${name}: no ../ specifier`);
    for (const [a, b] of pairs) t = t.split(`from ${a};`).join(`from ${b};`);
    assert.equal(t, fs.readFileSync(path.join(ctx.uf, from[name] ?? `client-repair-r4/lib/${name}`), "utf8"), `${name} reverses exactly`);
  }
  // patched copies: insert-only (anchored) or append-only, with the funding additions present
  const patched = { "site/js/boot.js": /funding: {3}\(\) => import\("\.\/pages\/funding\.js"\)/, "site/_redirects": /\n\/funding {4}\/funding\.html {4}200\n/,
    "scripts/build-site.mjs": /sessions: "sessions\.html", funding: "funding\.html" \};[\s\S]*"sessions\.html", "funding\.html", "404\.html"[\s\S]*funding\.manifest\.json/,
    "site/js/core/config.js": /export const FUNDING_RUNTIME = null;[\s\S]*FUNDING_MIGRATION_PROPOSAL = null;[\s\S]*FUNDING_MIGRATION_APPROVAL = null;/,
    "scripts/build-vendor.mjs": /await import\("\.\/build-funding-vendor\.mjs"\);\n$/ };
  for (const [t, re] of Object.entries(patched)) {
    const orig = fs.readFileSync(path.join(ctx.tmp, "source", t), "utf8");
    const out = fs.readFileSync(path.join(cand, t), "utf8");
    assert.ok(insertOnly(orig, out), `${t}: nothing of the original removed or changed`);
    assert.match(out, re, t);
    assert.equal(man.outputs[t].replaces_sha256, sha(Buffer.from(orig)), `${t}: replaces exactly the pinned source`);
    assert.equal(fs.readFileSync(path.join(cand, "ROLLBACK", t), "utf8"), orig, `${t}: rollback copy is the original`);
  }
  for (const t of ["site/js/core/config.js", "scripts/build-vendor.mjs"]) {
    assert.ok(fs.readFileSync(path.join(cand, t), "utf8").startsWith(fs.readFileSync(path.join(ctx.tmp, "source", t), "utf8")), `${t}: pure append`);
  }
  assert.match(fs.readFileSync(path.join(cand, "site", "funding.html"), "utf8"), /data-view="funding"[\s\S]*id="fdBody"/);
  assert.equal(man.outputs["site/js/funding/flows.js"].must_not_exist, true);
  assert.equal(man.rollback.filter((x) => x.action === "restore").length, 5);
  assert.equal(run(ctx).status === 0, false, "a second run refuses: candidate/ exists");
  fs.rmSync(ctx.tmp, { recursive: true, force: true });
});

test("generator refuses drift, a null pin, a wrong pin set, and overwriting an existing target", { skip }, () => {
  const cases = [
    ["drift", (c) => fs.appendFileSync(path.join(c.uf, "client-repair-r4", "lib", "migration.mjs"), "\n"), /!= pinned/],
    ["null pin", (c) => { c.pins.inputs["../source/site/_redirects"] = null; }, /no root-filled sha256/],
    ["pin set", (c) => { delete c.pins.inputs["../source/scripts/build-vendor.mjs"]; }, /must list exactly/],
    ["overwrite", (c) => { const f = path.join(c.tmp, "source", "site", "js", "funding", "state.js"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, "x"); }, /refusing to overwrite/],
    ["anchor gone", (c) => { const f = path.join(c.tmp, "source", "site", "_redirects"); fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("/grant      /grant.html      200\n", "")); c.pins.inputs["../source/site/_redirects"] = sha(fs.readFileSync(f)); }, /anchor occurs 0 times/],
  ];
  for (const [what, tweak, re] of cases) {
    const ctx = layout(tweak);
    const r = run(ctx);
    assert.notEqual(r.status, 0, what);
    assert.match(r.stderr + r.stdout, re, what);
    assert.equal(fs.existsSync(path.join(ctx.stage, "candidate")), false, `${what}: nothing written`);
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  }
});
