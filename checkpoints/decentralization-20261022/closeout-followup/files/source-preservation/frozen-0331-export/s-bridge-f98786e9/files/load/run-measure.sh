#!/bin/bash
# One load measurement inside a private user+network namespace (no route anywhere). The loopback carries the fake Sia
# host addresses 203.0.113.10.. (one per endpoint; the runner's child namespace adds the same ones) and 127.0.0.2 (the
# "indexer" control). Usage: run-measure.sh N_ENDPOINTS siaload-measure-args...   (through work/claude-test-queue.py)
set -u
n=$1; shift
exec timeout -k 10 "${JOB_SEC:-900}" unshare --user --map-root-user --net bash -c '
  ip link set lo up || exit 2
  i=0; while [ $i -lt "$0" ]; do ip address add 203.0.113.$((10 + i))/32 dev lo || exit 2; i=$((i + 1)); done
  exec python3 -I "$(dirname "$1")/siaload.py" measure --endpoints "$0" "${@:2}"' "$n" "$(realpath "$0")" "$@"
