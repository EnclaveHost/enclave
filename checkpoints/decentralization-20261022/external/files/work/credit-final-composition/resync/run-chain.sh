#!/usr/bin/env bash
# sequential, one job at a time; a run stopped by the host floor (99) is retried once after the host recovers
cd "$(dirname "$0")/.."; C=$PWD; G="env GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git GIT_OPTIONAL_LOCKS=0"
job() { local cap=$1 name=$2; shift 2
  for t in a b; do
    timeout 900 bash -c 'until [ $(awk "/MemAvailable/{print int(\$2/1024)}" /proc/meminfo) -gt 20000 ]; do sleep 15; done'
    rm -f logs/$name$t.rc; ./queue-retry.sh $cap $name$t -- "$@"; c=$?; echo "$name$t $c" >> resync/chain.txt
    [ $c -eq 99 ] || return 0
  done; }
: > resync/chain.txt
job 768 r-runner- bash $C/tree/test/run-credit-vault.sh runner
job 768 r-hp- $G bash $C/tree/test/run-credit-vault.sh hosted-placement
job 768 r-hpol- $G bash $C/tree/test/run-credit-vault.sh hosted-policy
job 768 r-stage- $G bash -c "cd $C/tree && node --test --test-concurrency=1 --test-reporter=spec test/hosted-services-stage.test.mjs"
job 768 r-reserve- bash $C/tree/test/run-credit-vault.sh reserve
job 512 r-unit- bash $C/tree/test/run-credit-vault.sh unit
job 768 r-win- $G bash -c "cd $C/tree && node --test --test-concurrency=1 --test-reporter=spec test/windows-lease-closure.test.mjs test/windows-current-runtime.test.mjs test/lease-gas-runtime.test.mjs test/windows-host-app-funded.test.mjs"
echo DONE >> resync/chain.txt
