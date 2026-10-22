#!/usr/bin/env bash
# 1) bundle the harness (esbuild, node22 target, everything inlined incl. fixtures and viem) 2) Linux dry run (portable +
# POSIX checks; the Windows-only checks report skipped) into a scratch base under the review logs.
set -uo pipefail
N=/home/steven/Documents/Codex/2026-10-18/wo/work/host-service-tls-20261021/native
cd "$N" && node --input-type=module -e "
import {build} from '../compose/node_modules/esbuild/lib/main.js';
await build({entryPoints:['g3-native.mjs'],outfile:'g3-native.bundle.mjs',bundle:true,platform:'node',format:'esm',target:'node22',
  banner:{js:'import { createRequire as __cr } from \"node:module\"; const require = __cr(import.meta.url);'}});
" && echo "bundle $(sha256sum g3-native.bundle.mjs)"
B=$N/dryrun; rm -rf "$B"; mkdir -p "$B"
node g3-native.bundle.mjs "$B" > "$N/dryrun.out" 2>&1; echo "dry run rc=$?"; ls -A "$B" | grep -v receipt && echo "LEFTOVER in base" || echo "base holds only the receipt"
grep -E '"(pass|skipped|error)"' "$N/dryrun.out" | head -20
