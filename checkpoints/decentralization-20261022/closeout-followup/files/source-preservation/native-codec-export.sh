#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
date -u +%FT%TZ
python3 -I manifest-drift.py
python3 -I export-native-codec.py
python3 -I verify-native-codec-export.py
date -u +%FT%TZ
