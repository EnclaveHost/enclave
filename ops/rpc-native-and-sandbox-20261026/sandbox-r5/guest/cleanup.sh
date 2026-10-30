#!/bin/bash
# guest/cleanup.sh ID (root): after the host fetched result.tar, remove ONLY this canary's units and paths; never another path or unit.
set -u; ID=${1:?id}; [[ $ID =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || exit 20
UNIT=enclave-sdcanary-$ID
systemctl stop "$UNIT-*.service" 2>/dev/null; systemctl reset-failed "$UNIT-*.service" 2>/dev/null
for d in /run/enclave-sdcanary-$ID /run/enclave-sdcanary-in-$ID /run/$UNIT-rt /etc/enclave-sdcanary-$ID /srv/enclave-sdcanary-$ID; do
  [[ $d =~ ^/(run|etc|srv)/enclave-sdcanary-(in-)?$ID(-rt)?$ ]] || exit 21
  [ -e "$d" ] && rm -rf --one-file-system -- "$d"; done
echo "## cleanup done $ID"
