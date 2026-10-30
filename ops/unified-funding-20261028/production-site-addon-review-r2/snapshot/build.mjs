#!/usr/bin/env node
/* ============================================================
   funding-r2 ADDON builder: a standalone /funding document for the
   live site, produced as file ADDITIONS only. Nothing existing is
   rewritten: old boot.js, chunks, pages and /vendor/sessions.js stay
   byte-for-byte; the page gets its own versioned module, legacy
   sessions SDK, funding SDK and CSS.

     node build.mjs --propose-pins --config C --existing-paths E --pins-out P
         full checks + esbuild, writes ONLY the proposed pins file P
         (reviewed:false) for root review
     node build.mjs --pins P --config C --existing-paths E --out DIR
         every input re-checked against the reviewed pins; writes
         DIR/site-additions/** + ADDITIONS.json/.sha256 + MANIFEST.json

   --existing-paths: one path per line of the immutable production
   tree (the CID's file listing). --css source (default: ship the
   source site/css/site.css under a versioned name) or live (keep the
   page on the existing /css/site.css).
   No network, no git, no upload, no activation.
   ============================================================ */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as L from "./lib.mjs";
import { VIEWS } from "./src/hard-nav.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULTS = {
  source: path.resolve(HERE, "../../source"),
  live: "/home/steven/Documents/Codex/2026-10-23/it/work/restore-queued-20261028/live-site-public",
  css: "source",
};
const ENTRY = path.join(HERE, "src", "entry.js");
const inside = (root, p) => { const r = path.relative(root, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

function writeNew(file, data) {
  const abs = path.resolve(file);
  const parent = path.dirname(abs);
  if (fs.realpathSync(parent) !== parent) throw new Error("output parent passes through a symlink: " + parent);
  fs.writeFileSync(abs, data, { flag: "wx" });   // never overwrite
}

export async function run(o) {
  const mode = o.mode;
  if (mode !== "propose" && mode !== "build") throw new Error("mode must be propose or build");
  const SOURCE = fs.realpathSync(o.source ?? DEFAULTS.source);
  const LIVE = fs.realpathSync(o.live ?? DEFAULTS.live);
  const SITE = path.join(SOURCE, "site");
  const cssMode = o.css ?? DEFAULTS.css;
  if (cssMode !== "source" && cssMode !== "live") throw new Error("--css must be source or live");

  const pins = mode === "build" ? L.validatePins(JSON.parse(L.readRegular(o.pins).toString("utf8"))) : null;
  const pinned = (key, actual) => {
    if (!pins) return actual;
    const want = key.startsWith("inputs:") ? pins.inputs[key.slice(7)] : pins[key];
    if (!want) throw new Error(`unpinned ${key}`);
    if (want !== actual) throw new Error(`${key}: ${actual} != pinned ${want}`);
    return actual;
  };

  /* every byte the artifact derives from: recorded by sha256 (and in build mode checked against the pins) */
  const inputs = new Map();
  const readInput = (rel) => {
    if (!inputs.has(rel)) {
      const abs = rel.startsWith("addon:") ? path.join(HERE, rel.slice(6)) : path.join(SOURCE, rel);
      const buf = L.readRegular(abs);
      inputs.set(rel, { buf, sha256: pinned("inputs:" + rel, L.sha256(buf)) });
    }
    return inputs.get(rel).buf;
  };
  const shaOf = (rel) => inputs.get(rel).sha256;
  const relOf = (abs) => {
    if (inside(path.join(HERE, "src"), abs)) return "addon:" + path.relative(HERE, abs).split(path.sep).join("/");
    if (inside(SOURCE, abs)) return path.relative(SOURCE, abs).split(path.sep).join("/");
    throw new Error("input outside the source checkout and addon src: " + abs);
  };

  // ---- reviewed public inputs: config, existing tree, live evidence ----
  const cfgBuf = L.readRegular(o.config);
  const cfgSha = pinned("config", L.sha256(cfgBuf));
  const cfg = L.validateConfig(JSON.parse(cfgBuf.toString("utf8")));
  const exBuf = L.readRegular(o.existingPaths);
  const exSha = pinned("existingPaths", L.sha256(exBuf));
  const existing = L.parseExistingPaths(exBuf.toString("utf8"));

  const invBuf = L.readRegular(path.join(LIVE, "inventory.json"));
  const invSha = pinned("liveInventory", L.sha256(invBuf));
  const inv = JSON.parse(invBuf.toString("utf8"));
  const liveMods = { ...inv.modules, ...inv.sessionModuleInspection };
  for (const [url, m] of Object.entries(liveMods)) {
    const abs = path.join(LIVE, url.replace(/^\/+/, ""));
    if (!inside(LIVE, abs)) throw new Error("live inventory path escapes: " + url);
    if (L.sha256(L.readRegular(abs)) !== m.sha256) throw new Error(`live evidence ${url} differs from inventory.json`);
  }
  if (!liveMods["/vendor/sessions.js"]) throw new Error("live inventory lacks /vendor/sessions.js");
  const liveSessionsSha = pinned("liveSessionsVendor", liveMods["/vendor/sessions.js"].sha256);
  const corpus = L.jsFilesUnder(path.join(LIVE, "js")).map((f) => L.readRegular(f).toString("utf8")).join("\n");

  // ---- opaque, hash-pinned vendors (scanned, never edited) ----
  const sessionsVendor = readInput("site/vendor/sessions.js");
  if (!shaOf("site/vendor/sessions.js").startsWith(L.LEGACY_SESSIONS_PREFIX))
    throw new Error(`site/vendor/sessions.js is not the qualified ${L.LEGACY_SESSIONS_PREFIX}… legacy SDK`);
  const fundingVendor = readInput("site/vendor/funding.js");
  const fside = JSON.parse(readInput("site/vendor/funding.manifest.json").toString("utf8"));
  if (shaOf("site/vendor/funding.js") !== fside.bundleSha256) throw new Error("site/vendor/funding.js differs from funding.manifest.json");
  readInput("sdk/funding/MANIFEST.json");
  if (shaOf("sdk/funding/MANIFEST.json") !== fside.coreManifestSha256) throw new Error("site/vendor/funding.js was built from another sdk/funding core");
  const vendorSpecs = {
    sessions: L.vendorImportSpecifiers(sessionsVendor.toString("utf8")),
    funding: L.vendorImportSpecifiers(fundingVendor.toString("utf8")),
  };
  for (const [k, specs] of Object.entries(vendorSpecs)) {
    const local = specs.filter((s) => /^(\/|\.\.?\/)/.test(s));
    if (local.length) throw new Error(`${k} vendor imports same-origin modules this addon does not ship: ${local.join(", ")}`);
  }
  const sessionsRel = `vendor/sessions.${L.VERSION}.${shaOf("site/vendor/sessions.js").slice(0, 16)}.js`;
  const fundingRel = `vendor/funding.${L.VERSION}.${shaOf("site/vendor/funding.js").slice(0, 16)}.js`;

  // ---- exact source replacements (versioned SDK paths, hard navigation, reviewed config) ----
  const configLiterals = L.checkConfigLiterals(readInput("site/js/core/config.js").toString("utf8"), corpus, cfg);
  const REPL = L.sourceReplacements({ sessionsUrl: "/" + sessionsRel, fundingUrl: "/" + fundingRel });
  const cfgPairs = L.configReplacements(cfg);
  if (cfgPairs.length) REPL["site/js/core/config.js"] = cfgPairs;

  // ---- esbuild: one ESM module, templates inlined, nothing written by esbuild ----
  const esbuild = createRequire(path.join(SOURCE, "package.json"))("esbuild");
  pinned("esbuildVersion", esbuild.version);
  const loaded = new Set();
  const applied = {};
  const SENTINEL = {
    [L.FUNDING_PAGE]: path.join(SITE, "js/pages/funding.js"),
    [L.WALLET_BUTTON]: path.join(SITE, "components/wallet-button/wallet-button.js"),
    [L.HARD_NAV]: path.join(HERE, "src/hard-nav.js"),
  };
  const plugin = {
    name: "funding-addon",
    setup(b) {
      b.onResolve({ filter: /^enclave-addon:/ }, (a) => SENTINEL[a.path] ? { path: SENTINEL[a.path] }
        : { errors: [{ text: "unknown addon specifier " + a.path }] });
      b.onResolve({ filter: /(^|\/)boot\.js$/ }, (a) => ({ errors: [{ text: `old router import refused: ${a.path} (from ${a.importer})` }] }));
      b.onLoad({ filter: /\.m?js$/ }, (a) => {
        const rel = relOf(a.path);
        const buf = readInput(rel);
        let src = buf.toString("utf8");
        if (!Buffer.from(src, "utf8").equals(buf)) throw new Error(rel + ": not UTF-8");
        if (REPL[rel]) {
          const r = L.applyExact(rel, src, REPL[rel]);
          applied[rel] = { originalSha256: shaOf(rel), replacedSha256: L.sha256(r.text), pairs: r.records, reverseEqual: r.reverseEqual };
          src = r.text;
        }
        if (L.COMPONENT_JS.test(rel))
          src = L.inlineTemplate(rel, src, (name) => readInput(path.posix.join(path.posix.dirname(rel), name)).toString("utf8"));
        loaded.add(rel);
        return { contents: src, loader: "js", resolveDir: path.dirname(a.path) };
      });
    },
  };
  const result = await esbuild.build({
    entryPoints: [ENTRY], absWorkingDir: SOURCE, outfile: path.join(HERE, ".virtual", "funding.js"),
    bundle: true, splitting: false, format: "esm", target: ["es2022"], minify: true,
    write: false, metafile: true, logLevel: "silent",
    external: ["/vendor/*", "https://*"], plugins: [plugin],
  });

  for (const k of Object.keys(result.metafile.inputs)) {
    const rel = relOf(path.resolve(SOURCE, k));
    if (!loaded.has(rel)) throw new Error("module not loaded through the pinned loader: " + rel);
  }
  const closure = L.checkClosure([...loaded].sort());
  for (const rel of Object.keys(REPL)) if (!applied[rel]) throw new Error(`replacement for ${rel} never applied (not in the module graph)`);
  if (result.outputFiles.length !== 1) throw new Error("expected exactly one bundle output");
  const bundle = Buffer.from(result.outputFiles[0].contents);
  const bundleText = bundle.toString("utf8");
  const outMeta = Object.values(result.metafile.outputs)[0];
  const versioned = ["/" + sessionsRel, "/" + fundingRel];
  const externals = L.checkExternals([...outMeta.imports.filter((i) => i.external).map((i) => i.path), ...L.vendorRefs(bundleText)],
    { versioned, existing });
  for (const v of versioned) if (!bundleText.includes(v)) throw new Error("bundle does not reference " + v);
  if (/["'`]\/vendor\/(sessions|funding)\.js["'`]/.test(bundleText)) throw new Error("bundle still references an unversioned SDK path");
  const bundleSha = L.sha256(bundle);
  const jsRel = `js/${L.VERSION}/funding.${bundleSha.slice(0, 16)}.js`;

  // ---- CSS ----
  let css = null, cssRel = "css/site.css", cssRefs = [];
  if (cssMode === "source") {
    css = readInput("site/css/site.css");
    cssRel = `css/site.${L.VERSION}.${shaOf("site/css/site.css").slice(0, 16)}.css`;
    cssRefs = L.cssRefs(css.toString("utf8")).map(L.cssRefPath);
    const miss = cssRefs.filter((r) => !existing.has(r));
    if (miss.length) throw new Error("site.css references files not in the existing tree: " + miss.join(", "));
  } else if (!existing.has("css/site.css")) throw new Error("--css live but css/site.css is not in the existing tree");

  // ---- standalone document ----
  const tpl = (name) => {
    const rel = `site/components/${name}/${name}.html`;
    return /^[a-z-]+$/.test(name) && fs.existsSync(path.join(SOURCE, rel)) ? readInput(rel).toString("utf8").trim() : null;
  };
  const H = L.transformHtml(readInput("site/funding.html").toString("utf8"),
    { tpl, cssHref: cssRel, moduleHref: jsRel, keepCss: cssMode === "live", stamp: `${L.VERSION} · ${bundleSha.slice(0, 8)}` });

  const additions = [
    { path: "funding.html", bytes: Buffer.from(H.html, "utf8") },
    { path: jsRel, bytes: bundle },
    { path: sessionsRel, bytes: sessionsVendor },
    { path: fundingRel, bytes: fundingVendor },
    ...(css ? [{ path: cssRel, bytes: css }] : []),
  ];
  L.planAdditions(additions, existing);
  const known = new Set([...existing, ...additions.map((a) => a.path)]);
  const links = L.localRefs(H.html);
  const missing = [...links.filter((r) => !L.existsIn(r, known)), ...VIEWS.filter((v) => !L.existsIn(v, existing))];
  if (missing.length) throw new Error("links/assets/navigation targets not in the existing tree: " + missing.join(", "));

  if (pins) for (const k of Object.keys(pins.inputs)) if (!inputs.has(k)) throw new Error("pinned input not used by this build: " + k);
  const inputPins = Object.fromEntries([...inputs].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.sha256]));
  const list = additions.map((a) => ({ path: a.path, sha256: L.sha256(a.bytes), bytes: a.bytes.length }));
  const manifest = {
    schema: "enclave-funding-addon-manifest-r2",
    version: L.VERSION,
    mode,
    source: SOURCE,
    live: LIVE,
    esbuildVersion: esbuild.version,
    pins: { config: cfgSha, existingPaths: exSha, liveInventory: invSha, liveSessionsVendor: liveSessionsSha },
    inputs: inputPins,
    moduleClosure: closure,
    replacements: applied,
    html: { source: shaOf("site/funding.html"), replacements: H.replacements, reverseEqual: H.reverseEqual,
      removedInlineScripts: H.removedInlineScripts, unbakedTags: H.unbaked, links },
    config: { release: cfg.release, funding: Object.fromEntries(L.FUNDING_KEYS.map((k) => [k, cfg.funding[k] === null ? null : L.sha256(JSON.stringify(cfg.funding[k]))])),
      literals: configLiterals },
    vendor: {
      sessions: { from: "site/vendor/sessions.js", sha256: shaOf("site/vendor/sessions.js"), path: sessionsRel,
        liveGlobalSha256: liveSessionsSha, differsFromLiveGlobal: shaOf("site/vendor/sessions.js") !== liveSessionsSha, importSpecifiers: vendorSpecs.sessions },
      funding: { from: "site/vendor/funding.js", sha256: shaOf("site/vendor/funding.js"), path: fundingRel,
        coreManifestSha256: fside.coreManifestSha256, importSpecifiers: vendorSpecs.funding },
    },
    css: { mode: cssMode, path: cssRel, references: cssRefs },
    navigation: { hardNavViews: [...VIEWS] },
    externals,
    additions: list,
  };

  if (mode === "propose") {
    const proposal = { schema: L.PINS_SCHEMA, reviewed: false, esbuildVersion: esbuild.version, config: cfgSha, existingPaths: exSha,
      liveInventory: invSha, liveSessionsVendor: liveSessionsSha, inputs: inputPins };
    writeNew(o.pinsOut, JSON.stringify(proposal, null, 2) + "\n");
    return { manifest, proposal };
  }

  // ---- write additions (fresh directory, no overwrite, nothing outside it) ----
  const OUT = path.resolve(o.out);
  for (const root of [SOURCE, LIVE, path.join(HERE, "src")]) if (inside(root, OUT)) throw new Error("output inside a protected tree: " + OUT);
  const parent = path.dirname(OUT);
  if (fs.realpathSync(parent) !== parent) throw new Error("output parent passes through a symlink: " + parent);
  fs.mkdirSync(OUT);                                    // EEXIST = refused
  for (const a of additions) {
    const abs = path.join(OUT, "site-additions", ...a.path.split("/"));
    if (!inside(path.join(OUT, "site-additions"), abs)) throw new Error("addition escapes output: " + a.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, a.bytes, { flag: "wx" });
  }
  writeNew(path.join(OUT, "ADDITIONS.json"), JSON.stringify(list, null, 2) + "\n");
  writeNew(path.join(OUT, "ADDITIONS.sha256"), list.map((a) => `${a.sha256}  ${a.path}`).join("\n") + "\n");
  writeNew(path.join(OUT, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, out: OUT };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: v } = parseArgs({ options: {
    "propose-pins": { type: "boolean" }, pins: { type: "string" }, "pins-out": { type: "string" },
    config: { type: "string" }, "existing-paths": { type: "string" }, out: { type: "string" },
    source: { type: "string" }, live: { type: "string" }, css: { type: "string" },
  } });
  const mode = v["propose-pins"] ? "propose" : "build";
  const need = ["config", "existing-paths", ...(mode === "propose" ? ["pins-out"] : ["pins", "out"])];
  const lack = need.filter((k) => !v[k]);
  if (lack.length) { console.error("[funding-addon] missing --" + lack.join(", --")); process.exit(2); }
  run({ mode, pins: v.pins, pinsOut: v["pins-out"], config: v.config, existingPaths: v["existing-paths"], out: v.out,
    source: v.source, live: v.live, css: v.css })
    .then((r) => {
      for (const a of r.manifest.additions) console.log(`  ${a.sha256}  ${String(a.bytes).padStart(8)}  ${a.path}`);
      console.log(mode === "propose" ? `[funding-addon] proposed pins -> ${v["pins-out"]} (review, set reviewed:true)` : `[funding-addon] additions -> ${r.out}`);
    })
    .catch((e) => { console.error("[funding-addon] REFUSED: " + (e?.message ?? e)); process.exit(1); });
}
