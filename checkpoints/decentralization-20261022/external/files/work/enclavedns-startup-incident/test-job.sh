#!/usr/bin/env bash
# EnclaveDNS startup incident: the sweepLiveness race fix in tree/, its regression tests, the neighbouring manager suites,
# and a mutation check (the unchanged main server.mjs must FAIL the new race test). Offline; nothing touches minipc.
set -uo pipefail
cd "$(dirname "$0")/tree/windows/vbslike/manager"
echo "== fixed tree: liveness + neighbouring manager suites"
node --test --test-concurrency=1 liveness.test.mjs restart.test.mjs regressions.test.mjs server.test.mjs console-log.test.mjs shield-profile.test.mjs ops/restart-accept.test.mjs ops/multi-accept.test.mjs
fixed=$?
echo "FIXED_RC=$fixed"
echo "== mutation: the unchanged main server.mjs against the new tests"
M=$(mktemp -d /tmp/claude-1000/enclavedns-mut-XXXX); cp -r ../../../. "$M/"
cp ../../../../server.mjs.before "$M/windows/vbslike/manager/server.mjs"
sha256sum "$M/windows/vbslike/manager/server.mjs"
(cd "$M/windows/vbslike/manager" && node --test --test-name-pattern="mid-start|real state|another handle" liveness.test.mjs)
mut=$?
echo "MUTATION_RC=$mut (must be non-zero)"
rm -rf "$M"
[ $fixed -eq 0 ] && [ $mut -ne 0 ] && echo ENCLAVEDNS-STARTUP-TEST-OK
