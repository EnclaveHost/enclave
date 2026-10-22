#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node probe4.mjs
echo PROBE4-JOB-OK
