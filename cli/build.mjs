// Bundle the CLI into one self-contained executable file (deps inlined).
// Shared by install.sh (POSIX) and install.ps1 (Windows) so neither shell has
// to quote the esbuild banner: `node build.mjs [outfile]`.
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(here, "dist", "enclave.mjs"));

const { build } = await import("esbuild").catch(() => {
  console.error("error: esbuild not found — run `npm install` in the repo root or in cli/");
  process.exit(1);
});
// The sessions SDK (../sdk/sessions/dist/node.mjs, imported by `enclave session`)
// keeps viem as a peer import. Resolve it - and any other viem import from
// outside cli/ - from HERE: the bundle then carries ONE viem, the CLI's pinned
// copy, and a checkout whose only node_modules is cli/'s (the hosted installer's
// `npm ci` in cli/) still builds, where sdk/ alone would find no viem at all.
// The same holds for the other packages shared modules outside cli/ import (custody/, network/): resolve them from
// cli/'s locked node_modules, or a hosted build (cli/ npm ci only) cannot find them at all.
const cliViem = {
  name: "cli-viem",
  setup(b) {
    b.onResolve({ filter: /^(viem|ws|@noble\/(hashes|ciphers|curves)|@freedomofpress\/[a-z-]+)(\/.*)?$/ }, (args) => {
      if (args.pluginData?.cliViem || args.resolveDir === here || args.resolveDir.startsWith(here + path.sep)) return undefined;
      return b.resolve(args.path, { kind: args.kind, resolveDir: here, pluginData: { cliViem: true } });
    });
  },
};
const result = await build({
  entryPoints: [path.join(here, "enclave.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [cliViem],
  // bundled deps still use require() internally; give them one.
  // process.argv[1] is hidden before any bundled module runs. Helpers that are also standalone tools
  // (cli/independent-capacity.mjs, cli/host-independent-lifecycle.mjs, windows/node/host-identity.mjs,
  // scripts/network/fetch-runtime.mjs) run their own main when argv[1] is their own file. In ONE bundled file that test
  // is true for every module, so they would also run on enclave's argv: the capacity tool exits 1 under `availability`,
  // and `host` runs twice. The CLI itself never reads argv[1].
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url); process.argv[1] = "";' },
  outfile: out,
  logLevel: "warning",
  metafile: true,
});
// A hosted install runs `npm ci` in cli/ only. A package this checkout found in the repo root's node_modules builds here
// and fails for every user, so refuse it now: name the package, and add it to cli/package.json (and the plugin above).
const rootModules = path.relative(process.cwd(), path.join(here, "..", "node_modules")) + path.sep;
const stray = [...new Set(Object.keys(result.metafile.inputs).filter((p) => path.normalize(p).startsWith(rootModules))
  .map((p) => { const seg = path.normalize(p).slice(rootModules.length).split(path.sep); return seg.slice(0, seg[0].startsWith("@") ? 2 : 1).join("/"); }))];
if (stray.length) { fs.rmSync(out, { force: true }); console.error(`error: bundled from the repo root's node_modules, which a hosted install does not have: ${stray.join(", ")}`); process.exit(1); }
if (process.platform !== "win32") fs.chmodSync(out, 0o755);
console.log(`bundled ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
