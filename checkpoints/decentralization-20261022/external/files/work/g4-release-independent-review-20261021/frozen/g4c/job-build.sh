#!/bin/bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/g4-network-composition-20261021 && node build-network-g4.mjs > build.out 2>&1; echo "exit=$?" >> build.out
for f in out/g4/*.mjs; do node --check "$f" && echo "check ok $f" >> build.out; done
