#!/bin/bash
# final candidate rewrap image, built twice from the same tree; plus the empty-mirror refusal
set -u
cd "$(dirname "$0")/../tree"
B=/home/steven/enclave-prod/dist-custody-9e5fb2028
V=0xe48699b8401564aace7a814ae4569b67a3f7eef5; K=0xab214342d5a490150a4a977063a2f88e21f80907
echo "== empty mirror list must be refused at build time"
node scripts/build-custody-rewrap.mjs --base $B --out ../build/never --vault $V --book $K --host-policy ../build/host-policy-production.json --allow-dirty 2>&1 | grep -m1 -E "HTTPS origins|Error" ; [ ! -e ../build/never ] && echo "refused: no image written"
for n in final-1 final-2; do echo "== $n"; node scripts/build-custody-rewrap.mjs --base $B --out ../build/$n --vault $V --book $K --allow-dirty 2>&1 | grep -v "not a git repository" || exit 1; done
cmp ../build/final-1/initramfs.cpio.gz ../build/final-2/initramfs.cpio.gz && echo "DETERMINISTIC: initramfs byte-identical"
