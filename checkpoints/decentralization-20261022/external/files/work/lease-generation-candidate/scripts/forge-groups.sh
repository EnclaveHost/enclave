#!/bin/sh
# Run each named test file as its own guarded forge job (only that file's import closure compiles), serially, in the
# foreground. Usage: scripts/forge-groups.sh NAME.t.sol ...   Logs: out/forge/<name>.log, summary: out/forge/summary.txt
set -u
C=$(cd "$(dirname "$0")/.." && pwd); F=$C/forge; GUARD=$C/../enclave/test/helpers/memory-guard.mjs
mkdir -p "$C/out/forge"; status=0
for t in "$@"; do
  skips=""
  for other in "$F"/contracts/foundry/test/*.t.sol; do b=$(basename "$other"); [ "$b" = "$t" ] || skips="$skips --skip contracts/foundry/test/$b"; done
  log="$C/out/forge/${t%.t.sol}.log"
  ( cd "$F" && node "$GUARD" --max-rss-mib 768 --floor-available-mib 16384 --log "$C/out/forge/guard.log" -- \
      forge test $skips --match-path "contracts/foundry/test/$t" ) > "$log" 2>&1
  rc=$?
  line=$(grep -E '^Ran [0-9]+ test suite' "$log" | tail -1); peak=$(grep -o 'peakTreeRssMiB=[0-9]*' "$log" | tail -1)
  echo "$t exit=$rc $peak ${line:-NO SUMMARY}" | tee -a "$C/out/forge/summary.txt"
  [ $rc -eq 0 ] || status=1
done
exit $status
