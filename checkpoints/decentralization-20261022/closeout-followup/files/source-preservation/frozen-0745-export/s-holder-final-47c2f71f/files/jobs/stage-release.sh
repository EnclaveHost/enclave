#!/bin/bash
set -eu
cd "$(dirname "$0")/.."
exec timeout -k 5 300 python3 -I tools/stage_release.py evidence/upstream-20261023T043317Z/base-releases.json staging/base-v1.5.1-$(date -u +%Y%m%dT%H%M%SZ)
