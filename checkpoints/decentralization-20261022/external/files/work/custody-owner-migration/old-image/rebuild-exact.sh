#!/bin/bash
# BYTE-EXACT rebuild of the RUNNING custodian bundle (/opt/custodian/custodian.mjs of custodian-v2-9d43e63e8, sha256
# 7c2cd000…, root's runtime-image-provenance.json) from commit 9d43e63 source, with that commit's own esbuild options
# (scripts/build-custodian-v2.mjs at 9d43e63) and measured literal.
# The bundle's module keys record the original build layout: sources at a working directory SIX path components deep and
# node_modules resolved to /home/steven/Projects/enclave/node_modules (esbuild 0.28.1, viem 2.53.1, @noble/* as locked).
# This script recreates exactly that layout from a fresh `git archive` and compares bytes. Read-only for both repositories.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
HIST=/home/steven/Projects/enclave
COMMIT=9d43e63e84e1799467a0202c0cf1cdc5a8aabca5
EXPECTED=7c2cd000f5e57d9c5bf8a9e28985b7950ad912ea0deef721bdaabc7a479715a5
W=$(mktemp -d /tmp/rx.XXXXXX); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/a/b/c"; S="$W/a/b/c/s"; mkdir "$S"            # /tmp/rx.*/a/b/c/s = 6 path components
[ "$(echo "$S" | tr -cd / | wc -c)" = 6 ] || { echo "layout depth is not 6: $S"; exit 2; }
git -C "$HIST" archive "$COMMIT" custody isolation/contract relay/snp-verify.mjs verifier package.json package-lock.json | tar -x -C "$S"
ln -s "$HIST/node_modules" "$S/node_modules"
cd "$S"
node --input-type=module - "$EXPECTED" "$HERE/rebuild-exact-result.json" "$COMMIT" <<'EOF'
import fs from "node:fs"; import path from "node:path"; import { createHash } from "node:crypto";
const [EXPECTED, OUT, COMMIT] = process.argv.slice(2);
const { build, version } = await import(path.resolve("node_modules/esbuild/lib/main.js"));
const measured = `export const MEASURED = Object.freeze(${JSON.stringify({ chainId: 8453, vault: "0xe48699b8401564aace7a814ae4569b67a3f7eef5",
  rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org", "https://1rpc.io/base"],
  minAgree: 2, maxAgeSec: 120, enclaveOwner: "0x0b2d009c0c9af05b12100d77f3c815fea822ee61" })});\n`;
const r = await build({ entryPoints: [path.join(process.cwd(), "custody/v2/daemon.mjs")], bundle: true, platform: "node", format: "esm", target: "node22",
  write: false, legalComments: "none", metafile: true, banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  plugins: [{ name: "measured", setup(b) { b.onLoad({ filter: /custody[\\/]v2[\\/]measured\.mjs$/ }, () => ({ contents: measured, loader: "js" })); } }] });
const bytes = Buffer.from(r.outputFiles[0].contents), sha = createHash("sha256").update(bytes).digest("hex");
const repo = Object.keys(r.metafile.inputs).filter((f) => !f.includes("node_modules")).sort();
const result = { commit: COMMIT, esbuild: version, sha256: sha, expected: EXPECTED, byteExact: sha === EXPECTED, bytes: bytes.length,
  repoInputs: Object.fromEntries(repo.map((f) => [f, createHash("sha256").update(fs.readFileSync(f)).digest("hex")])) };
fs.writeFileSync(OUT, JSON.stringify(result, null, 1) + "\n");
console.log(JSON.stringify({ sha256: sha, expected: EXPECTED, byteExact: result.byteExact, bytes: bytes.length, repoInputs: repo.length }));
process.exit(result.byteExact ? 0 : 1);
EOF
