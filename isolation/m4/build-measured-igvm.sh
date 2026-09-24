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

# THE FIRMWARE PIN. A measured table is worth nothing over a firmware that does not read it, and this builder
# will happily emit one for any firmware declaring a KERNEL_HASHES area - the distro OvmfPkgX64 declares one and
# links BlobVerifierLibNull. Every structural check still passes in that case, so structure cannot be the gate;
# the firmware's identity has to be. See verifying-firmware.txt for what admits a digest to that list.
PIN=${PIN:-$here/verifying-firmware.txt}
fwsha=$(sha256sum "$FW" | cut -c1-64)
if ! grep -qE "^$fwsha[[:space:]]" "$PIN"; then
  echo "FAIL: $FW (sha256 $fwsha) is not a firmware known to VERIFY the measured table." >&2
  echo "      A byte-perfect table over a non-verifying firmware passes every structural check and checks" >&2
  echo "      nothing at runtime, so this is refused rather than built. Known-verifying digests:" >&2
  grep -E "^[0-9a-f]{64}[[:space:]]" "$PIN" | awk '{printf "        %s  %s\n", substr($1,1,16)"...", $2}' >&2
  echo "      To add one, run the substitution negative against it and cite the evidence in $PIN." >&2
  exit 2
fi
echo "   firmware $FW"
echo "            sha256 $fwsha (pinned as verifying: $(grep -E "^$fwsha[[:space:]]" "$PIN" | awk '{print $2}'))"

FEATURES=${FEATURES:-vtpm,uefivars,enable-console-log}
echo "== building the SVSM and its tools (RELEASE=1, FEATURES=$FEATURES)"
# The identity tables are compiled IN, via option_env!, so they are part of the launch measurement. State them,
# because "which app is this SVSM built to admit" is not readable from the IGVM afterwards. Verified 2026-09-24
# that changing ENCLAVE_APP_IDS does rebuild the kernel crate and change the binary, so a stale table cannot
# survive a change here - but a FAILED build could leave the previous binary in place and be measured as if it
# were this one, so the build must not be allowed to fail quietly. It used to: the `|| make ...` fallback below
# hid a compile error and the script went on to measure whatever was already on disk.
for v in ENCLAVE_APP_IDS ENCLAVE_RUNTIME_SHA256 ENCLAVE_RUNTIME_IDS; do
  eval "val=\${$v:-}"
  echo "   $v=${val:-<unset: the table is all zeros and every plane is unassigned>}"
done
# bin/bldr, bin/svsm-fs.bin and the SVSM ELF all come from the config-driven `cargo xbuild` behind the
# bin/coconut-qemu.igvm rule, so that one target is what produces the pieces this script then assembles itself.
# The IGVM it writes is discarded; only its prerequisites matter. FW_FILE must be the real firmware - passing
# `none` makes the rule hand `--firmware none` to igvmbuilder and fail.
( cd "$KIT" && make RELEASE=1 FEATURES="$FEATURES" FW_FILE="$FW" bin/coconut-qemu.igvm ) \
  > "${BUILDLOG:-/dev/null}" 2>&1 || {
  echo "FAIL: the SVSM build failed - refusing to measure whatever binary is already on disk" >&2
  [ -n "${BUILDLOG:-}" ] && tail -20 "$BUILDLOG" >&2
  exit 1; }
IGVMBLD=$KIT/target/release/igvmbuilder
SVSMELF=$KIT/target/x86_64-unknown-none/release/svsm
for f in "$IGVMBLD" "$SVSMELF" "$KIT/bin/bldr" "$KIT/bin/svsm-fs.bin"; do
  [ -r "$f" ] || { echo "FAIL: the SVSM build did not produce $f" >&2; exit 1; }
done
echo "   svsm elf sha256 $(sha256sum "$SVSMELF" | cut -c1-64)"

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
# THE GATE, at PAGE level. Comparing only the 176 table bytes is not enough: a table placed at the wrong offset
# inside the right page compares perfectly and is still invisible to the firmware, which reads its own FixedPcd
# address, finds zeros, and boots nothing. So extract the whole 4096-byte page and compare it to
# construct_page(offset), with the offset taken from the firmware's own SEV_HASH_TABLE_RV_GUID entry.
echo "== checking the emitted page against sev-snp-measure"
pg=$(mktemp); trap 'rm -f "$pg"' EXIT
python3 - "$OUT" "$pg" "$FW" <<'PY'
import sys
sys.path.insert(0, '/home/steven/.local/lib/python3.14/site-packages')
from sevsnpmeasure.ovmf import OVMF
d = open(sys.argv[1], 'rb').read()
off = OVMF(sys.argv[3]).sev_hashes_table_gpa() & 0xfff
g = bytes.fromhex('06d63894224fc94cb479a793d411fd21')   # the SevHashTable header GUID, on the wire
offs = []
i = 0
while (i := d.find(g, i)) >= 0:
    offs.append(i); i += 1
if len(offs) != 1:
    sys.exit(f'FAIL: the header GUID appears {len(offs)} times in the IGVM, expected exactly once')
start = offs[0] - off
if start < 0:
    sys.exit(f'FAIL: the table is at file offset {offs[0]}, too early to sit {off:#x} into a page')
open(sys.argv[2], 'wb').write(d[start:start + 4096])
PY
python3 "$here/hash-table.py" "$GK" "$GI" "$GC" --compare-page "$pg" --firmware "$FW" || {
  echo "FAIL: the page in $OUT is not the page sev-snp-measure builds - REMOVING it" >&2
  rm -f "$OUT"; exit 1; }

echo "== launch digest"
dg=$("$KIT/target/release/igvmmeasure" "$OUT" measure | grep -i "Launch Digest" | sed 's/.*: *//')
[ -n "$dg" ] || { echo "FAIL: igvmmeasure produced no digest" >&2; exit 1; }
echo "Launch Digest: $dg"
sz=$(stat -c %s "$OUT")
[ "$sz" -gt 3900000 ] || { echo "FAIL: $OUT is only $sz bytes - too small to contain firmware" >&2; exit 1; }

# THE MANIFEST. The digest depends on inputs the IGVM does not name, and the SVSM ELF is not reproducible, so
# without this record a digest cannot be tied back to what produced it. Everything a verifier would have to pin
# goes here: the guest artifacts the table covers, the firmware (whose identity is what makes the table mean
# anything), the SVSM pieces, and the identity tables compiled into the SVSM.
man="${OUT%.igvm}.manifest.json"
sha() { sha256sum "$1" | cut -c1-64; }
cat > "$man" <<JSON
{
  "igvm": {"path": "$OUT", "bytes": $sz, "launchDigest": "$dg", "sha256": "$(sha "$OUT")"},
  "guest": {
    "kernel":  {"path": "$GK", "sha256": "$(sha "$GK")"},
    "initrd":  {"path": "$GI", "sha256": "$(sha "$GI")"},
    "cmdline": $(printf '%s' "$GC" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
  },
  "firmware": {"path": "$FW", "sha256": "$fwsha", "pinnedVerifyingBy": "$PIN"},
  "svsm": {
    "features": "$FEATURES", "release": true,
    "elf":  "$(sha "$SVSMELF")",
    "bldr": "$(sha "$KIT/bin/bldr")",
    "fs":   "$(sha "$KIT/bin/svsm-fs.bin")"
  },
  "identity": {
    "ENCLAVE_APP_IDS": "${ENCLAVE_APP_IDS:-}",
    "ENCLAVE_RUNTIME_SHA256": "${ENCLAVE_RUNTIME_SHA256:-}",
    "ENCLAVE_RUNTIME_IDS": "${ENCLAVE_RUNTIME_IDS:-}"
  },
  "hashTable": {"note": "at the firmware's SEV_HASH_TABLE_RV_GUID address, not the descriptor base"}
}
JSON
python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$man" || {
  echo "FAIL: the manifest is not valid JSON" >&2; rm -f "$man"; exit 1; }
echo "OK  $OUT ($sz bytes, firmware $FW)"
echo "    manifest $man"
