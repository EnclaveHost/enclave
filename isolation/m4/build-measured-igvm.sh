#!/usr/bin/env bash
# Build an IGVM whose launch digest covers the guest's kernel, initrd and command line (step 0b+2).
#
# WHY A SCRIPT. The M4b IGVMs were built by hand, which is how an IGVM with no firmware in it got measured and
# reported as if it could boot, and how a hash table with three wrong GUIDs nearly reached a hardware run. The
# build now refuses to produce a file unless the table it emitted is byte-for-byte the table sev-snp-measure
# would build. There is no flag to skip that check.
#
# WHAT THE THREE PIECES DO TOGETHER
#   igvmbuilder --guest-kernel/--guest-initrd/--guest-cmdline   emits the SevHashTable as MEASURED page data
#   the same code splits the pre-validated area around that page  so the SVSM does not validate-and-ZERO it
#   GuestFwInfoBlock.hash_table_address/size                    so the SVSM GRANTS the page to the guest VMPL
# Any one of the three alone is useless, and two of the three fail in ways that look like something else: no
# split means a blank table, and no grant means the firmware faults on a page it cannot read.
#
#   usage: build-measured-igvm.sh [-o OUT] [-k KERNEL] [-i INITRD] [-c CMDLINE] [-f FIRMWARE]
#          defaults come from m1/domain.env, except the initrd which has none - pass it.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/../m1/domain.env"

KIT=${KIT:-$HOME/.cache/enclave-isolation/svsmkit/svsm}
OUT=${OUT:-$HOME/enclave-bench/m4b-measured.igvm}
GK=${GK:-$KERNEL}
GI=${GI:-}
GC=${GC:-$APPEND}
FW=${FW:-$OVMF}
while getopts "o:k:i:c:f:" o; do case $o in
  o) OUT=$OPTARG;; k) GK=$OPTARG;; i) GI=$OPTARG;; c) GC=$OPTARG;; f) FW=$OPTARG;;
  *) exit 2;; esac; done

[ -n "$GI" ] || { echo "FAIL: no initrd given (-i); the table must cover the initrd that actually boots" >&2; exit 2; }
for f in "$GK" "$GI" "$FW"; do
  [ -r "$f" ] || { echo "FAIL: cannot read $f" >&2; exit 2; }
done

FEATURES=${FEATURES:-vtpm,uefivars,enable-console-log}
echo "== building the SVSM and its tools (RELEASE=1, FEATURES=$FEATURES)"
( cd "$KIT" && make RELEASE=1 FEATURES="$FEATURES" bin/igvmbld target/x86_64-unknown-none/release/svsm \
    >/dev/null 2>&1 || make RELEASE=1 FEATURES="$FEATURES" FW_FILE=none igvm >/dev/null 2>&1 )
IGVMBLD=$KIT/target/release/igvmbuilder
SVSMELF=$KIT/target/x86_64-unknown-none/release/svsm
for f in "$IGVMBLD" "$SVSMELF" "$KIT/bin/bldr" "$KIT/bin/svsm-fs.bin"; do
  [ -r "$f" ] || { echo "FAIL: the SVSM build did not produce $f" >&2; exit 1; }
done

echo "== building $OUT"
mkdir -p "$(dirname "$OUT")"
( cd "$KIT" && "$IGVMBLD" \
    --output "$OUT" --kernel "$SVSMELF" --bldr bin/bldr --filesystem bin/svsm-fs.bin \
    --firmware "$FW" --policy 0x30000 --comport 1 --snp \
    --guest-kernel "$GK" --guest-initrd "$GI" --guest-cmdline "$GC" qemu )

# THE GATE. Pull the table out of the file that was just written - not out of what the builder says it wrote -
# and compare the WHOLE thing against sev-snp-measure. A table whose header passes but whose entries are
# malformed does not refuse anything: the firmware reports no matching entry and returns EFI_SUCCESS for every
# blob, so a booting guest would prove nothing. This is the only place that catches it.
echo "== checking the emitted table against sev-snp-measure"
tbl=$(mktemp); trap 'rm -f "$tbl"' EXIT
python3 - "$OUT" "$tbl" <<'PY'
import sys
d = open(sys.argv[1], 'rb').read()
g = bytes.fromhex('06d63894224fc94cb479a793d411fd21')   # the SevHashTable header GUID, on the wire
offs = []
i = 0
while (i := d.find(g, i)) >= 0:
    offs.append(i); i += 1
if len(offs) != 1:
    sys.exit(f'FAIL: the header GUID appears {len(offs)} times in the IGVM, expected exactly once')
open(sys.argv[2], 'wb').write(d[offs[0]:offs[0] + 176])
PY
python3 "$here/hash-table.py" "$GK" "$GI" "$GC" --compare "$tbl" || {
  echo "FAIL: the table in $OUT is not the table sev-snp-measure builds - REMOVING it" >&2
  rm -f "$OUT"; exit 1; }

echo "== launch digest"
"$KIT/target/release/igvmmeasure" "$OUT" measure | grep -i "Launch Digest" || {
  echo "FAIL: igvmmeasure produced no digest" >&2; exit 1; }
sz=$(stat -c %s "$OUT")
[ "$sz" -gt 3900000 ] || { echo "FAIL: $OUT is only $sz bytes - too small to contain firmware" >&2; exit 1; }
echo "OK  $OUT ($sz bytes, firmware $FW)"
