#!/usr/bin/env bash
# local v2 tests (no network beyond loopback): v2 must pass; the old implementations (test/old fixtures) and the mutant must fail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021/public-canary-resume/a5-authority/final/tunnel-install
date -u +%FT%TZ; sha256sum tunnel_install.py vm/* minipc/* test/*.py test/old/* | cut -c1-16,65-; sshd -V 2>&1 | head -1
s() { grep -E "\.\.\. (ok|FAIL|ERROR)$|^(OK|FAILED)" "$1"; }
timeout 120 python3 test/test_controller_static.py > test/v2-static.out 2>&1; echo "static rc=$?"; s test/v2-static.out
timeout 120 python3 test/test_vm_state.py > test/v2-vm-state.out 2>&1; echo "vm-state rc=$?"; s test/v2-vm-state.out
ROLLBACK=old timeout 120 python3 test/test_vm_state.py > test/v2-vm-state-OLD.out 2>&1; echo "vm-state OLD rollback rc=$? (expected non-zero)"; s test/v2-vm-state-OLD.out
timeout 420 python3 test/test_tunnel_local.py > test/v2-local.out 2>&1; echo "local rc=$?"; s test/v2-local.out
VERIFIER=old timeout 300 python3 test/test_tunnel_local.py TunnelTests.test_the_vm_verifier_does_not_pass_with_a_wrong_key TunnelTests.test_the_vm_verifier_does_not_pass_against_a_closed_port > test/v2-local-OLDVERIFIER.out 2>&1; echo "OLD verifier rc=$? (expected non-zero)"; s test/v2-local-OLDVERIFIER.out
TUNNEL_TEST_MUTANT=open timeout 420 python3 test/test_tunnel_local.py > test/v2-local-mutant.out 2>&1; echo "mutant rc=$? (expected non-zero)"; s test/v2-local-mutant.out
date -u +%FT%TZ
