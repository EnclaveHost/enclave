#!/usr/bin/env bash
# VARIANT B (7d NATIVE-WRITER-REVIEW proposal, NOT adopted): the same entries built from src with ONLY
# network/wallet-admission.mjs replaced by 7d's proposed writer 358c7aa9 (explicit, pinned). Output build/out/variantB.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; P=$W/node-hold-package-20261021; B=$P/srcB
F=$W/node-hold-host-review-20261021/proposed/wallet-admission.mjs.proposed
[ "$(sha256sum $F | cut -d' ' -f1)" = 358c7aa92c5413e0c2a3953b2189d1d8258d8b3541c2629b743821678c6319f8 ] || { echo "variant B writer pin mismatch"; exit 1; }
rm -rf $B; cp -a $P/src $B; cp $F $B/network/wallet-admission.mjs
cd $B && node -e "
const {build}=await import('$B/node_modules/esbuild/lib/main.js');
for (const f of ['privacy-agent.mjs','windows-circuit-worker.mjs']) await build({entryPoints:['$B/network/'+f],outfile:'$P/build/out/variantB/'+f,absWorkingDir:'$B',bundle:true,platform:'node',format:'esm',target:'node22',logLevel:'error',
  banner:{js:'import {createRequire as bundleRequire} from \"node:module\"; const require=bundleRequire(import.meta.url);'}});" --input-type=module
rm -rf $B; sha256sum $P/build/out/variantB/*.mjs
