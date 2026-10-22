#!/usr/bin/env bash
set -euo pipefail; cd "$(dirname "$0")"; node build-network.mjs; for f in out/candidate/*.mjs; do node --check "$f"; done; sha256sum out/*/*.mjs out/build-manifest.json
