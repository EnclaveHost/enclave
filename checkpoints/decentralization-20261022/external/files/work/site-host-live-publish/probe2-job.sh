#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node probe2.mjs
echo PROBE2-JOB-OK
