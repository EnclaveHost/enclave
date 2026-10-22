#!/usr/bin/env bash
# (immutable; v1) read-only staleness attribution
set -euo pipefail
cd "$(dirname "$0")"; node attribute-staleness.mjs
