#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node probe3.mjs
echo PROBE3-JOB-OK
