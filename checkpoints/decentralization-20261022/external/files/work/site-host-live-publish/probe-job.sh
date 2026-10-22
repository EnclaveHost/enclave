#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node probe.mjs
echo PROBE-JOB-OK
