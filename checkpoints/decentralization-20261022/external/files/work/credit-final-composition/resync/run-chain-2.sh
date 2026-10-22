#!/usr/bin/env bash
# relay single-flight fix: every suite whose inputs changed, sequential, one job at a time; a host-floor stop (99) retried once
cd "$(dirname "$0")/.."; C=$PWD; G="env GIT_DIR=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/.git GIT_OPTIONAL_LOCKS=0"
job() { local cap=$1 name=$2; shift 2
  for t in a b; do
    timeout 900 bash -c 'until [ $(awk "/MemAvailable/{print int(\$2/1024)}" /proc/meminfo) -gt 20000 ]; do sleep 15; done'
    rm -f logs/$name$t.rc; ./queue-retry.sh $cap $name$t -- "$@"; c=$?; echo "$name$t $c" >> resync/chain-2.txt
    [ $c -eq 99 ] || return 0
  done; }
: > resync/chain-2.txt
job 768 f-conc- bash $C/tree/test/run-credit-vault.sh concurrency
job 768 f-node- bash $C/tree/test/run-credit-vault.sh node
job 768 f-runner- bash $C/tree/test/run-credit-vault.sh runner
job 768 f-hp- $G bash $C/tree/test/run-credit-vault.sh hosted-placement
job 512 f-unit- bash $C/tree/test/run-credit-vault.sh unit
job 256 f-neg- bash $C/tree/test/run-credit-vault.sh negative
echo DONE >> resync/chain-2.txt
