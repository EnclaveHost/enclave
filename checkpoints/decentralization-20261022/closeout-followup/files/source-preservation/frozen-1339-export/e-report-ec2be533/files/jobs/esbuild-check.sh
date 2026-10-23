#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
git -C repo log -1 --format='HEAD %H'; git -C repo status --short | head
exec timeout -k 5 300 node jobs/esbuild-check.mjs repo tmp/esb
