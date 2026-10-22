#!/usr/bin/env bash
# G4 control set (work/g4-node-ai-final-20261021, copied from g4-node-final-package-20261021; P points HERE, never at the frozen original): 605's FROZEN composed set (node-hold-package-20261021/control/new,
# verified by its SHA256SUMS 3b2c1906 entries) + EXACTLY three G4 files from g4-network-composition-20261021/control-delta/new.
# Writes only into THIS package. (compose.sh beside this is 605's original, kept for provenance: it targets 605's package and
# must not be run from here.)
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work; P=$W/g4-node-ai-final-20261021; F=$W/node-hold-package-20261021/control; D=$W/g4-network-composition-20261021/control-delta/new
pin(){ [ "$(sha256sum "$1" | cut -d' ' -f1)" = "$2" ] || { echo "PIN MISMATCH $1 (want $2)"; exit 1; }; }
pin $F/SHA256SUMS.txt 3b2c1906bc9f011d89613efe2759151dbc1d66fbc7fa699fb4d2f6d7310fdef2
( cd $F && sha256sum -c --quiet SHA256SUMS.txt ) || { echo "605's control set does not verify"; exit 1; }
rm -rf $P/control/old $P/control/new; cp -a $F/old $P/control/old; cp -a $F/new $P/control/new
cp $D/network-enroll.mjs $P/control/new/network-enroll.mjs;             pin $P/control/new/network-enroll.mjs a9729786598107e69d24d5163ea8592d114f93a9b6693106a7fa3414c95430d6
cp $D/host-service-names.mjs $P/control/new/host-service-names.mjs;     pin $P/control/new/host-service-names.mjs a46123cbb70ab666f9dfb23b5b545fe76d87658c6bf82c7f7574579d0c65b32c
cp $D/host-service-transport.mjs $P/control/new/host-service-transport.mjs; pin $P/control/new/host-service-transport.mjs de5bb98a2e77ffd90ccf65211f564d9515f667b4cd6d17cbb3644fb2ca454e06
cd $P/control; sha256sum old/* new/* > SHA256SUMS.txt; cat SHA256SUMS.txt
