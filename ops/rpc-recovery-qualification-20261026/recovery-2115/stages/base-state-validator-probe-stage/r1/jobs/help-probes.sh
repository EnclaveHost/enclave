#!/bin/bash
# base-state-validator-probe-stage/r1: ROOT bounded --help/version probes of the PINNED production base v1.5.1 binary (prepared by Claude
# 1678; NOT run by Claude). No datadir, no data, no network (unshare -Urn), HOME/XDG pointed at a fresh empty temp dir, <=512 MiB lane,
# 30 s per call, output capped at 256 KiB per call. --help never opens storage (clap prints and exits).
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh base-help-probes 512 unshare -Urn bash base-state-validator-probe-stage/r1/jobs/help-probes.sh
set -uo pipefail
export PATH=/usr/bin:/bin LC_ALL=C
BIN=/home/steven/Documents/Codex/2026-10-18/wo/work/fresh-witness-supply/staging/base-v1.5.1-20261023T053947Z/base
SHA=9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; echo "## base-help-probes rc=9"; exit 9; }
[ "$(sha256sum < $BIN | cut -c1-64)" = $SHA ] || { echo "binary is not the pinned base v1.5.1"; echo "## base-help-probes rc=9"; exit 9; }
T=$(mktemp -d); trap 'rm -rf -- "$T"' EXIT; cp $BIN $T/base && chmod 0500 $T/base
[ "$(sha256sum < $T/base | cut -c1-64)" = $SHA ] || { echo "copy mismatch"; exit 9; }
rc=0
for args in "--version" "--help" "db --help" "db version --help" "db stats --help" "db stage-checkpoints --help" "db static-file-header --help" \
            "db repair-trie --help" "db checksum --help" "db get --help" "db state --help" "stage --help" "node --help" "rpc --help"; do
  echo "===== base $args"
  (cd $T && env -i PATH=$PATH LC_ALL=C HOME=$T XDG_CACHE_HOME=$T XDG_CONFIG_HOME=$T XDG_DATA_HOME=$T timeout -k 5 30 ./base $args < /dev/null 2>&1 | head -c 262144); r=${PIPESTATUS[0]}
  echo "===== rc=$r"
done
[ -z "$(find $T -mindepth 1 ! -name base -print -quit)" ] || { echo "## a --help probe wrote files:"; find $T -mindepth 1 ! -name base | head; rc=1; }
echo "## base-help-probes rc=$rc"; exit $rc
