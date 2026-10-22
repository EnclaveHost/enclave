#!/usr/bin/env bash
# One 1024 MiB queue job: (1) the negative control (every new suite with INJECT_FAILURE must exit nonzero), (2) the hardware
# canary policy from the ACTUAL Shield-direct candidate record, validated by the production validators (offline, no network).
set -euo pipefail
cd "$(dirname "$0")"
rc=0
c=0; bash tree/test/run-certificate-hosted.sh negative || c=$?; echo "[final] negative exit=$c"; [ $c -eq 0 ] || rc=1
c=0; unshare -rn node canary/make-canary-policy.mjs tree canary || c=$?; echo "[final] canary policy exit=$c"; [ $c -eq 0 ] || rc=1
echo "[final] exit=$rc"; exit $rc
