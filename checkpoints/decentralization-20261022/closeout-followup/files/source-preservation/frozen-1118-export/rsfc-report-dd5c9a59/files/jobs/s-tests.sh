#!/bin/bash
# S's own runners on the COMPOSED S clone (s/), with S's environment pointed at this clone (history for its git-show
# controls) and at an owned scratch directory on the workspace ext4 filesystem.
set -u
C=$(cd "$(dirname "$0")/.." && pwd)
export HOLDER_NVME_SCRATCH=$C/scratch HOLDER_GIT_REPO=$C/s
case "${1:-tests}" in
tests) JOB_SEC=600 exec bash $C/s/holder/run-tests.sh holder ;;
mutants) shift; JOB_SEC=1800 exec bash $C/s/holder/run-mutants.sh "$@" ;;
esac
