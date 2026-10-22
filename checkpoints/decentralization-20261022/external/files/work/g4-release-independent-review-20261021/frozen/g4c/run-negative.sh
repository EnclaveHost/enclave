#!/usr/bin/env bash
# negative control: the new enroll test against 605's ORIGINAL network-enroll 6bd0a858 (in MY mirror only; restored by trap)
P=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-network-composition-20261021; M=$P/mirror/windows/node/network-enroll.mjs
trap 'cp $P/control-delta/new/network-enroll.mjs $M; echo "restored $(sha256sum $M | cut -c1-8)"' EXIT
cp $P/control-delta/base/network-enroll.mjs $M; echo "testing original $(sha256sum $M | cut -c1-8)"
cd $P/mirror && node --test --test-reporter=tap test/windows-node-challenge-enroll.test.mjs 2>&1 | grep -E "^(ok|not ok)|error:" | head -4
