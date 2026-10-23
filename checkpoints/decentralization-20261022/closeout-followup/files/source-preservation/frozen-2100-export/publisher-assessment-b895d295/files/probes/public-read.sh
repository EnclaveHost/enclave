#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec timeout -k 5 330 node probes/public-read.mjs "$@"
