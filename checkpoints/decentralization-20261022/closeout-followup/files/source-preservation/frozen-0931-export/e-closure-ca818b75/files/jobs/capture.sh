#!/bin/bash
# BOUNDED read-only research capture (two public providers per chain, <= 24 HTTP requests each spec). No sending.
set -u
C=$(cd "$(dirname "$0")/.." && pwd); cd "$C" || exit 2
date -u +%FT%TZ; sha256sum tools/capture-state.mjs evidence/capture/spec-*.json
timeout -k 5 120 node tools/capture-state.mjs evidence/capture/spec-l1-portal.json evidence/capture/l1-portal.json
timeout -k 5 120 node tools/capture-state.mjs evidence/capture/spec-l2-gpo.json evidence/capture/l2-gpo.json
sha256sum evidence/capture/*.json
