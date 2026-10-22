#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
for host in us-west ap-southeast eu-central; do
  checklog="logs/root-$host-check.txt"
  bash activate-front.sh "$host" check | tee "$checklog"
  runid=$(sed -n 's/^run-id \(ens-[^ ]*\).*/\1/p' "$checklog")
  [[ "$runid" =~ ^ens-[0-9]{8}T[0-9]{6}Z$ ]]
  grep -q '"state": "CHECK_OK"' "$checklog"
  bash activate-front.sh "$host" activate "$runid" | tee "logs/root-$host-activate.txt"
  grep -q '"state": "ACTIVE"' "logs/root-$host-activate.txt"
done
