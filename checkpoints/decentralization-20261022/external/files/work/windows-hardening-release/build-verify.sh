#!/usr/bin/env bash
# The Windows release's sources on CURRENT main (tree/ = rsync of work/enclave): regenerate the lease bundle, verify every
# bundle input is the tree's own file, derive the deploy closure with main's own builder, run the closure/cold-load and the
# actual chain-module tests. One shared-queue admission.
set -u
cd "$(dirname "$0")/tree"
fail=0
run() { echo "=== STEP $*"; "$@"; local e=$?; echo "=== EXIT $e: $*"; [ $e -ne 0 ] && fail=1; return 0; }
run node scripts/build-windows-lease-runtime.mjs
run node -e '
const fs=require("fs"),path=require("path"),crypto=require("crypto");
const m=JSON.parse(fs.readFileSync("windows/node/lease-gas-runtime.bundle.mjs.manifest.json","utf8"));
const sha=(f)=>crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const bad=[];let n=0;
for(const [rel,h] of Object.entries(m.inputs)){n++;const f=rel.startsWith("node_modules/")?["windows/node/"+rel,rel].find(p=>fs.existsSync(p)):rel;if(!f||sha(f)!==h)bad.push(rel);}
if(sha("windows/node/lease-gas-runtime.bundle.mjs")!==m.sha256)bad.push("bundle sha");
console.log(JSON.stringify({bundle:m.sha256,bytes:m.bytes,inputs:n,mismatched:bad}));process.exit(bad.length?1:0);'
run node --input-type=module -e '
import { closure } from "./windows/node/deploy-files.mjs";
import fs from "node:fs";
const r = closure({ root: process.cwd() });
fs.writeFileSync("../closure.json", JSON.stringify(r, null, 1) + "\n");
console.log(JSON.stringify({ files: r.files.length, problems: r.problems }));
process.exit(r.problems.length ? 1 : 0);'
run node --test --test-concurrency=1 test/windows-lease-closure.test.mjs test/windows-current-runtime.test.mjs
echo "=== BATCH $([ $fail -eq 0 ] && echo PASS || echo FAIL)"
exit $fail
