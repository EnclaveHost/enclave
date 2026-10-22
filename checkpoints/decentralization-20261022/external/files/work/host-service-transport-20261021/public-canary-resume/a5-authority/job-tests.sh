#!/usr/bin/env bash
# Targeted only: the new A5 test against the PATCHED tree (must pass) and against the BASE tree (negative control: the
# merge tests must fail), plus the existing read-only DNS test on the patched tree (unchanged behaviour). Loopback only.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/host-service-transport-20261021/public-canary-resume/a5-authority
date -u +%FT%TZ; sha256sum ttree/relay/dns-relay.js ttree/network/host-services/roles.mjs ttree-base/relay/dns-relay.js test/challenge-txt-upstream.test.mjs | cut -c1-16,65-
A5_TREE=$PWD/ttree node --test --test-reporter=tap test/challenge-txt-upstream.test.mjs > patched.tap 2>&1; echo "patched rc=$?"
A5_TREE=$PWD/ttree-base node --test --test-reporter=tap test/challenge-txt-upstream.test.mjs > base.tap 2>&1; echo "base rc=$? (expected non-zero)"
(cd ttree && ENCLAVE_DNS_BIN=$PWD/relay/dns-relay.js node --test --test-reporter=tap test/dns-read-only.test.mjs) > readonly-existing.tap 2>&1; echo "existing dns-read-only on patched rc=$?"
grep -E "^(not )?ok|^# (pass|fail)" patched.tap base.tap readonly-existing.tap
date -u +%FT%TZ
