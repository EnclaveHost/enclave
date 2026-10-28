#!/usr/bin/env node
// client-site-browser-r1 page-bundle build driver. UNREVIEWED, NOT RUN by its author. ROOT runs it (separate step).
//   node client-site-browser-r1/build/build-harness.mjs
// Bundles shell/main.mjs + the UNMODIFIED client-site-repair-r2 page/flows/state + the ACTUAL source util.js into
// page/dist/harness.js with the source checkout's existing esbuild (dependency "esbuild", required version 0.28.1,
// resolved from source/package.json). Nothing is written unless every check passes:
//   1. every input in generated/BUILD-PINS.json has a root-filled sha256 and matches it (null or drift refuses);
//   2. module resolution is an explicit allowlist: the page's site imports map to the TEST facades listed below, its
//      own ../funding/*.js and ../core/util.js resolve to the actual files, /harness/vendor/{funding,sessions}.js stay
//      external (served as-is by the server); ANY other specifier refuses the build;
//   3. the bundle's inputs are exactly the pinned files (no node_modules, nothing else), so the page, flows and state
//      bytes in the bundle are the pinned r2 bytes; the only difference from the site build is module resolution.
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");          // client-site-browser-r1
const UF = path.dirname(HERE);                                                               // unified-funding-20261028
const ROOT = path.dirname(UF);                                                               // rpc-production-final-20261025
const SOURCE = path.join(ROOT, "source");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const refuse = (m) => { throw new Error(`build-harness: ${m} (refusing; nothing written)`); };

const require = createRequire(path.join(SOURCE, "package.json"));
const ESBUILD_VERSION = "0.28.1";
const esbuildPkg = JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve("esbuild")), "..", "package.json"), "utf8"));
if (esbuildPkg.name !== "esbuild" || esbuildPkg.version !== ESBUILD_VERSION) refuse(`esbuild ${esbuildPkg.name}@${esbuildPkg.version} is not esbuild@${ESBUILD_VERSION}`);
const { build } = require("esbuild");

// 1. pins
const pins = JSON.parse(fs.readFileSync(path.join(HERE, "generated", "BUILD-PINS.json"), "utf8")).inputs;
for (const [rel, want] of Object.entries(pins)) {
  if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want)) refuse(`${rel}: no root-filled sha256`);
  const got = sha(fs.readFileSync(path.join(UF, rel)));
  if (got !== want) refuse(`${rel}: sha256 ${got} != pinned ${want}`);
}
const abs = (rel) => path.resolve(UF, rel);
const R2 = abs("client-site-repair-r2/authored/site/js");
const PAGE = path.join(R2, "pages", "funding.js");
const STATE = path.join(R2, "funding", "state.js");
const FLOWS = path.join(R2, "funding", "flows.js");
const UTIL = path.join(SOURCE, "site", "js", "core", "util.js");
const SHELL = path.join(HERE, "shell");
const FACADE = (f) => path.join(SHELL, "facade", f);
const EXTERNAL = new Set(["/harness/vendor/funding.js", "/harness/vendor/sessions.js"]);

// 2. explicit resolution table: importer -> specifier -> file (the page's ten imports + one dynamic import)
const TABLE = new Map([
  [PAGE, new Map([
    ["../../components/header/header.js", FACADE("empty.js")],
    ["../../components/footer/footer.js", FACADE("empty.js")],
    ["../../components/toast/toast.js", FACADE("empty.js")],
    ["../core/api.js", FACADE("api.js")],
    ["../core/wallet.js", FACADE("wallet.js")],
    ["../core/util.js", UTIL],                                   // ACTUAL
    ["../core/sessions.js", FACADE("sessions.js")],
    ["../core/config.js", FACADE("config.js")],
    ["../funding/state.js", STATE],                              // ACTUAL r2
    ["../funding/flows.js", FLOWS],                              // ACTUAL r2
    ["/vendor/funding.js", FACADE("vendor-funding.js")],
  ])],
  [FLOWS, new Map([["./state.js", STATE]])],
  [path.join(SHELL, "main.mjs"), new Map([
    ["../../../source/site/js/core/util.js", UTIL],
    ["./facade/api.js", FACADE("api.js")],
    ["./harness-state.js", path.join(SHELL, "harness-state.js")],
    ["../../client-site-repair-r2/authored/site/js/pages/funding.js", PAGE],
  ])],
  [FACADE("config.js"), new Map([["../harness-state.js", path.join(SHELL, "harness-state.js")]])],
  [FACADE("sessions.js"), new Map([["./api.js", FACADE("api.js")], ["../harness-state.js", path.join(SHELL, "harness-state.js")]])],
  [FACADE("vendor-funding.js"), new Map([["../harness-state.js", path.join(SHELL, "harness-state.js")]])],
]);
const resolver = {
  name: "client-site-browser-r1-explicit-resolution",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      if (args.kind === "entry-point") return { path: path.resolve(args.path) };
      if (EXTERNAL.has(args.path)) return { path: args.path, external: true };
      const to = TABLE.get(args.importer)?.get(args.path);
      if (!to) return { errors: [{ text: `unlisted import ${JSON.stringify(args.path)} from ${path.relative(UF, args.importer)}` }] };
      return { path: to };
    });
  },
};

const result = await build({
  absWorkingDir: ROOT, entryPoints: [path.join(SHELL, "main.mjs")], bundle: true, format: "esm", platform: "browser",
  target: ["es2022"], minify: false, sourcemap: false, legalComments: "eof", metafile: true, write: false,
  outfile: path.join(HERE, "page", "dist", "harness.js"), plugins: [resolver], logLevel: "warning",
});
if (result.errors.length) refuse(`esbuild reported ${result.errors.length} error(s)`);

// 3. exactly the pinned inputs, nothing else (no node_modules, no unlisted file)
const inputs = Object.keys(result.metafile.inputs).map((p) => path.resolve(ROOT, p)).sort();
const expected = Object.keys(pins).filter((rel) => /\.(m?js)$/.test(rel) && !rel.includes("candidate/") && !rel.includes("sdk/sessions/dist"))
  .map(abs).sort();
if (inputs.join("\n") !== expected.join("\n")) {
  refuse(`bundle inputs differ from the pinned set:\n  got      ${inputs.map((p) => path.relative(UF, p)).join("\n           ")}\n  expected ${expected.map((p) => path.relative(UF, p)).join("\n           ")}`);
}
for (const p of [PAGE, STATE, FLOWS, UTIL]) if (!inputs.includes(p)) refuse(`${path.relative(UF, p)} is not in the bundle`);
if (result.outputFiles.length !== 1) refuse("expected exactly one output file");
const bytes = Buffer.from(result.outputFiles[0].contents);
const text = bytes.toString("utf8");
for (const ext of EXTERNAL) if (!text.includes(JSON.stringify(ext))) refuse(`external ${ext} is not referenced`);
for (const bad of ["window.ethereum", "enclave_wallet_session", "https://", "eth_requestAccounts"]) {
  if (text.replace(/\/\*[\s\S]*?\*\//g, "").includes(bad)) refuse(`bundle contains ${bad}`);
}
fs.mkdirSync(path.join(HERE, "page", "dist"), { recursive: true });
fs.writeFileSync(path.join(HERE, "page", "dist", "harness.js"), bytes);
console.log(`[build] page/dist/harness.js ${bytes.length} bytes sha256 ${sha(bytes)}`);
console.log(`[build] inputs: ${inputs.map((p) => path.relative(UF, p)).join(", ")}`);
