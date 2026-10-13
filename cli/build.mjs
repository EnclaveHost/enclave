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
const cliViem = {
  name: "cli-viem",
  setup(b) {
    b.onResolve({ filter: /^viem(\/.*)?$/ }, (args) => {
      if (args.pluginData?.cliViem || args.resolveDir === here || args.resolveDir.startsWith(here + path.sep)) return undefined;
      return b.resolve(args.path, { kind: args.kind, resolveDir: here, pluginData: { cliViem: true } });
    });
  },
};
await build({
  entryPoints: [path.join(here, "enclave.mjs")],
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [cliViem],
  // bundled deps still use require() internally; give them one
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  outfile: out,
  logLevel: "warning",
});
if (process.platform !== "win32") fs.chmodSync(out, 0o755);
console.log(`bundled ${out} (${Math.round(fs.statSync(out).size / 1024)} KB)`);
