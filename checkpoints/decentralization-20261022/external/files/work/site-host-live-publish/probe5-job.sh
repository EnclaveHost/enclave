#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node probe5.mjs
echo PROBE5-JOB-OK
