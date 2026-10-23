#!/bin/bash
# node --test over the named test files of this tree (TMPDIR on disk; whole-job wall clock bound inside)
set -uo pipefail
cd "$(dirname "$0")/../repo"
export TMPDIR="$(cd .. && pwd)/tmp"
git log -1 --format='HEAD %H' 2>/dev/null; git status --short | head -40
sha256sum site/js/core/{config,independent,chain,wallet,fund,pay,custody,sessions,independent-chain,platform-addresses}.js site/js/pages/grant.js site/components/admin-console/migrator.js test/site-browser-rpc-closure.test.mjs test/helpers/browser-rpc-scenario.mjs
exec timeout -k 10 "${JOB_SEC:-900}" node --test --test-force-exit --test-concurrency=1 "$@"
