#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-release-independent-review-20261021/test
date -u +%FT%TZ; sha256sum root-injection-vs-rev2.mjs; timeout 120 node root-injection-vs-rev2.mjs; echo "rc=$?"; date -u +%FT%TZ
