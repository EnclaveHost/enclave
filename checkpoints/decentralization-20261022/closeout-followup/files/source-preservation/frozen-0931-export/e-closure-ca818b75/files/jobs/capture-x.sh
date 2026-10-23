#!/bin/bash
# Cross-check capture at the SAME pinned blocks from two other public providers (read-only, paced, <= 30 requests each).
set -u
C=$(cd "$(dirname "$0")/.." && pwd); cd "$C" || exit 2
date -u +%FT%TZ; sha256sum tools/capture-state.mjs evidence/capture/spec-*-x.json
timeout -k 5 200 node tools/capture-state.mjs evidence/capture/spec-l1-portal-x.json evidence/capture/l1-portal-x.json
timeout -k 5 200 node tools/capture-state.mjs evidence/capture/spec-l2-gpo-x.json evidence/capture/l2-gpo-x.json
sha256sum evidence/capture/*-x.json
