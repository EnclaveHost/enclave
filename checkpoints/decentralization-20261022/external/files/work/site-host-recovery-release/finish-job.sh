#!/usr/bin/env bash
# ONE queued job (512 MiB; node only, no rebuild). Finishes the recovery release after run rs3 (logs/rs3.out: steps 0-6
# passed: deterministic site, review+verify, frontend closure, reproducible wasm 4044ea81..., fleet e2e 6/6, named routes):
#   7. the wording delta shipped and the old wording is unreachable (delta-check.mjs; the PRIOR release must FAIL it)
#   8. the prior frozen release/package is byte-unchanged (its FINAL.sha256)
#   9. deliver/package = the twice-built component + its upload CID (kubo-identical importFile), and FINAL.sha256
set -euo pipefail
cd "$(dirname "$0")"
CID=bafybeic7sud3ozsx7fbyo5iwwzqxs3pun54kppahf5eaocupahxmwikjzq
REL="release/$CID"
OLD=../site-host-final-release/release/bafybeibs6ouoiqwsr632yvb4ffvmpee4bvxhiaqdg64khrijnt6lgbt3na

echo "== 7. delta check (new release passes; the prior release must fail)"
node delta-check.mjs "$REL"
if node delta-check.mjs "$OLD" > logs/delta-check-prior.txt 2>&1; then echo "the prior release passed the delta check"; exit 1; fi
grep -o "a current file carries the old wording: [^,]*" logs/delta-check-prior.txt | head -1
echo "PRIOR-RELEASE-FAILS-DELTA-CHECK"

echo "== 8. prior frozen artifacts unchanged"
(cd ../site-host-final-release && sha256sum -c --quiet deliver/FINAL.sha256) && echo "PRIOR-FROZEN-UNCHANGED"

echo "== 9. deliver/package"
rm -rf deliver && mkdir -p deliver/package
cp site-host/dist/site_host.wasm site-host/dist/PACKAGE.json site-host/dist/SOURCE.sha256 deliver/package/
cp site-host/target/component.wit deliver/package/component.wit
cmp deliver/package/site_host.wasm repro/site-host/dist/site_host.wasm
node --input-type=module - deliver/package/site_host.wasm "$REL" <<'JS'
import fs from "node:fs";
import { createHash } from "node:crypto";
import { importFile, cidString } from "../enclave/scripts/site-release/unixfs.mjs";
const [wasm, rel] = process.argv.slice(2), bytes = fs.readFileSync(wasm);
const pkg = JSON.parse(fs.readFileSync("deliver/package/PACKAGE.json", "utf8")), sha = createHash("sha256").update(bytes).digest("hex");
if (pkg.wasm.sha256 !== sha || pkg.wasm.bytes !== bytes.length) throw Error("PACKAGE.json does not describe the wasm");
const lock = JSON.parse(fs.readFileSync("site-host/release.lock.json", "utf8")), m = JSON.parse(fs.readFileSync(rel + "/release.json", "utf8"));
if (lock.cid !== m.cid || pkg.release.cid !== m.cid || pkg.release.car.sha256 !== m.car.sha256) throw Error("lock/package/release disagree");
const upload = cidString(importFile(bytes).cid);
const out = { schema: "site-host-recovery-release/1", status: "FROZEN - NOT UPLOADED, NOT PUBLISHED, NOT SIGNED",
  wasm: { sha256: sha, bytes: bytes.length, uploadCid: upload }, release: { cid: m.cid, car: m.car, createdAt: m.createdAt, source: m.source, base: m.base },
  config: JSON.stringify({ release: m.cid, wasi: "0.2" }) };
fs.writeFileSync("deliver/RELEASE.json", JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify(out, null, 1)); console.log("EXPECTED-UPLOAD-CID " + upload);
JS
sha256sum deliver/package/* deliver/RELEASE.json site-host/release.lock.json "$REL/site.car" "$REL/release.json" "$REL/headers.caddy" \
  recovery-site-job.sh finish-job.sh delta-check.mjs frontend-closure.mjs route-check.mjs logs/tree-copy.sha256 > deliver/FINAL.sha256
cat deliver/FINAL.sha256
echo "RECOVERY-FINISH-OK $CID"
