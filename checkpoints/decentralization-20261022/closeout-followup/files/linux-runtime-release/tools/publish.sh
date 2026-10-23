#!/usr/bin/env bash
# publish (no build, no test: copies + path sanitizing only): receipts and job logs -> public/ with local paths replaced by
# <build> (this directory), <work> (the work tree) and <prod> (/home/steven/enclave-prod); then PINS.sha256 over RESULT,
# RECIPE, public/, tools/ and patches/. image/, rawlogs/, src/, tmp/ and stub/ are not published (image: distribute by hash).
set -euo pipefail
B=$(cd "$(dirname "$0")/.." && pwd); W=/home/steven/Documents/Codex/2026-10-18/wo/work
san() { sed -e "s#$B#<build>#g" -e "s#$W#<work>#g" -e "s#/home/steven/enclave-prod#<prod>#g" -e "s#/home/steven/#<home>/#g" "$1" > "$2"; }
for f in inputs-precheck.json inputs-build.json image-verify.json import-check.json source-commits.txt composed-ls-tree.txt \
         composed-delta-vs-493ee9ee.txt patches.sha256 artifacts-A.sha256 release-tar.sha256 build-started.utc build-finished.utc; do
  san "$B/receipts/$f" "$B/public/$f"
done
for f in lineage-compare.json ACTIVATION-REQUIREMENTS.json; do san "$B/public/$f" "$B/public/$f.tmp" && mv "$B/public/$f.tmp" "$B/public/$f"; done
( cd "$B/receipts" && for f in t1-*.rc t2-*.rc; do echo "$(basename "$f" .rc) $(cat "$f")"; done ) > "$B/public/test-group-exits.txt"
for j in s1-compose t1-tests t2-overlay-unittest b1-build v1-verify s2-scan; do
  { echo "# $j: queue guard line(s)"; cat "$B/rawlogs/$j.guard.log"; echo "# retries before admission: $( [ -f "$B/rawlogs/$j.retries" ] && wc -l < "$B/rawlogs/$j.retries" || echo 0)"; echo "# exit $(cat "$B/rawlogs/$j.rc")"; echo; cat "$B/rawlogs/$j.out"; } > "$B/tmp/log.$j"
  san "$B/tmp/log.$j" "$B/public/log-$j.txt"; rm "$B/tmp/log.$j"
done
cp "$B/image/dist-linux-fec43a6a0/MEASUREMENT" "$B/public/MEASUREMENT"; cp "$B/public/inputs-build.json" "$B/public/INPUT-MANIFEST.json"
grep -l -E '/home/steven' "$B"/public/* && { echo "an unsanitized path remains"; exit 3; } || true
( cd "$B" && sha256sum RESULT-LINUX-PACKAGE.md RECIPE.md public/* tools/* patches/* ) > "$B/PINS.sha256"
wc -l "$B/PINS.sha256"
