#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
node probe3b.mjs
echo PROBE3B-JOB-OK
