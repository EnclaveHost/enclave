#!/usr/bin/env bash
# Reviewer: rebuild stage-r4 from compose4 with the SAME builder in a temp dir (--check), require the recorded archives.
export TMPDIR=/home/steven/Documents/Codex/2026-10-18/wo/work/compose4-review/tmp
W=/home/steven/Documents/Codex/2026-10-18/wo/work
cd $W/host-service-tls-20261021/compose4 && node scripts/build-host-service-packages.mjs --check >/dev/null 2>&1; echo "packages-check rc=$?"
cd $W/hosted-services-activation && timeout 600 node build-stage-r2.mjs --tree $W/host-service-tls-20261021/compose4 --app-static capture/app-static.json --out $W/host-service-tls-20261021/stage-r4 --check; echo "stage-r4 repro rc=$?"
