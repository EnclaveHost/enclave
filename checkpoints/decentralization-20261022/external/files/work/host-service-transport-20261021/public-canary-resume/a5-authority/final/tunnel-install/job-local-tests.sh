#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021/public-canary-resume/a5-authority/final/tunnel-install
date -u +%FT%TZ; sha256sum vm/* test/test_tunnel_local.py | cut -c1-16,65-; sshd -V 2>&1 | head -1
timeout 300 python3 test/test_tunnel_local.py > test/local-tests.out 2>&1; echo "restricted rc=$?"
TUNNEL_TEST_MUTANT=open timeout 300 python3 test/test_tunnel_local.py > test/local-tests-mutant.out 2>&1; echo "mutant rc=$? (expected non-zero)"
grep -E "\.\.\. (ok|FAIL|ERROR)$|^(OK|FAILED)" test/local-tests.out; echo "--- mutant"; grep -E "\.\.\. (ok|FAIL|ERROR)$|^(OK|FAILED)" test/local-tests-mutant.out
date -u +%FT%TZ
