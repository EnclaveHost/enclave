#!/bin/bash
# ext4-recovery-checksum-stage/r1: ROOT runs the qualifier ONCE on the real COPIED journal (prepared by Claude 1643; NOT run by Claude).
# Only after jobs/tests.sh passed. Offline: reads the 1 GiB journal copy (4 KiB preads at the inventory's image offsets only) and the
# root 1626 inventories; writes one new JSON under $OUT. No device, image, USB, data block or network. Not a recovery or acceptance.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh ext4-checksum-r1-real 512 unshare -Urn bash ext4-recovery-checksum-stage/r1/jobs/run-real-copy.sh
set -uo pipefail
export PATH=/usr/bin:/bin LC_ALL=C
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/ext4-recovery-checksum-stage/r1; D=$P/logs/base-journal-copy-1626
JOURNAL_SHA=d95d81fcaf1fdecb305f5645bc5bf2d6093d0a7fc40affbfc769894798cbc073        # root 1626 record.json journalSha256
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## ext4-checksum r1 != SHA256SUMS"; echo "## ext4-checksum-r1-real rc=9"; exit 9; }
[ "$(cat $P/logs/ext4-checksum-r1-tests.rc 2>/dev/null)" = 0 ] && grep -q "^## ext4-checksum-r1-tests rc=0$" $P/logs/ext4-checksum-r1-tests.out \
  || { echo "## the fixture tests have not passed"; echo "## ext4-checksum-r1-real rc=9"; exit 9; }
[ "$(sha256sum < $D/journal-8.bin | cut -c1-64)" = $JOURNAL_SHA ] || { echo "## journal copy != $JOURNAL_SHA"; echo "## ext4-checksum-r1-real rc=9"; exit 9; }
OUT=$S/runs/real-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p $OUT || exit 9
for f in inventory-with-index.json inventory-leaves.json; do sha256sum $D/$f; done > $OUT/inputs.sha256
env -i PATH=$PATH LC_ALL=C timeout -k 5 1800 python3 -I -B $S/ext4_candidate_checksums.py --journal $D/journal-8.bin \
  --inventory $D/inventory-with-index.json --inventory $D/inventory-leaves.json \
  --uuid 11c6bbac-f823-4052-a87a-066eed6ad590 --ino 1950053 --gen 3326586236 --inode-size 256 --inode-table-block 499122230 \
  --inode-offset 1024 --at-or-before-seq 17169 --fs-blocks 976562500 --huge-file yes --no-csum-seed --expect-size 1138166333440 \
  --out $OUT/ext4-candidate-checksums.json < /dev/null; rc=$?
[ $rc = 0 ] && python3 -I -c 'import json,sys; r=json.load(open(sys.argv[1])); print(json.dumps({k: r.get(k) for k in ("metadataChecksumsValid","recoveryProven","problems")}, indent=1)); print(json.dumps({k: v for k, v in r.get("map", {}).items() if k != "extentList"}, indent=1)); print("chosenInode", json.dumps(r.get("chosenInode")))' $OUT/ext4-candidate-checksums.json
echo "## outputs: $OUT"; echo "## ext4-checksum-r1-real rc=$rc"; exit $rc
