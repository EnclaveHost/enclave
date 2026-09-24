#!/bin/sh
# Step 2: does the LAUNCH MEASUREMENT bind the kernel, initrd and command line that actually execute?
#
# WHY THIS IS NOT THE M2 TEST. m2/verify-firmware.sh asks whether a firmware verifies the table QEMU writes.
# On the IGVM path QEMU writes NO table - it says so in target/i386/sev.c ("the IGVM file will be used to
# configure the metadata pages directly") - so a verifying firmware inside an IGVM refuses every guest
# (evidence/igvm-0b-precondition-2026-09-24.txt). igvmbuilder now emits the table itself as MEASURED page data,
# which is what puts the guest's artifacts inside the IGVM digest rather than merely beside it.
#
# READ THIS BEFORE SCORING ANYTHING. A malformed table does NOT refuse. BlobVerifierSevHashes searches for a
# per-blob GUID and treats "not found" as EFI_SUCCESS, so a table the firmware cannot parse verifies nothing and
# the guest boots normally - silently, on a RELEASE build. **A booting guest is therefore not evidence that
# verification happened.** That is why case 1 below demands the firmware's own "Hash comparison succeeded" line
# for all THREE blobs, and why "Hash GUID not found in table" is INFRA and never a pass. Run this against a
# firmware built with BUILD_TARGET=DEBUG or it cannot be scored at all.
#
# THE THREE CASES, one IGVM digest per case, so each says one thing:
#
#   control        the IGVM's table covers the served image  -> BOOTS, and 3/3 blobs verified
#   substitution   the SAME IGVM, a DIFFERENT initrd served  -> does NOT boot, initrd comparison FAILS
#   notable        an IGVM built with no table at all        -> does NOT boot, firmware reports no table
#
# The third case is not redundant. Without it, case 1 passing is equally consistent with a firmware that checks
# nothing, and case 2 failing to boot is equally consistent with a broken image. notable shows the firmware still
# refuses when the table is absent, so the table is what made the difference.
#
# usage: verify-measured-boot.sh <good.cpio.gz> <other.cpio.gz> [workdir]
#   good    the image the IGVM is built over, and the one case 1 serves
#   other   any DIFFERENT image, served in case 2 under the case-1 IGVM
set -e
here=$(cd "$(dirname "$0")" && pwd)
GOOD=${1:?usage: verify-measured-boot.sh <good.cpio.gz> <other.cpio.gz> [workdir]}
OTHER=${2:?usage: verify-measured-boot.sh <good.cpio.gz> <other.cpio.gz> [workdir]}
W=${3:-$HOME/enclave-bench/m4b-step2-$(date +%H%M%S)}
mkdir -p "$W"
. "$here/../m1/domain.env"
FW=${FW:-$HOME/.cache/enclave-isolation/fwbuild/OVMF.amdsev.debug.fd}
[ -r "$GOOD" ] && [ -r "$OTHER" ] || { echo "cannot read both images"; exit 2; }
[ -r "$FW" ] || { echo "no DEBUG firmware at $FW - a RELEASE build cannot be scored (see the header)"; exit 2; }
cmp -s "$GOOD" "$OTHER" && { echo "the two images are identical; case 2 would test nothing"; exit 2; }

echo "workdir   $W"
echo "firmware  $FW (sha256 $(sha256sum "$FW" | cut -c1-16)...)"
echo "good      $GOOD (sha256 $(sha256sum "$GOOD" | cut -c1-16)...)"
echo "other     $OTHER (sha256 $(sha256sum "$OTHER" | cut -c1-16)...)"

echo "== building the two IGVMs"
"$here/build-measured-igvm.sh" -o "$W/measured.igvm" -i "$GOOD" -f "$FW" > "$W/build-measured.log" 2>&1 || {
  echo "ABORT: the measured IGVM did not build (its own table check is fail-closed):"; sed 's/^/  /' "$W/build-measured.log" | tail -8; exit 1; }
grep -E "Pre-validated regions recorded|Measured SEV hash table at|Launch Digest" "$W/build-measured.log" | sed 's/^/  /'
KIT=${KIT:-$HOME/.cache/enclave-isolation/svsmkit/svsm}
( cd "$KIT" && ./target/release/igvmbuilder --output "$W/notable.igvm" \
    --kernel target/x86_64-unknown-none/release/svsm --bldr bin/bldr --filesystem bin/svsm-fs.bin \
    --firmware "$FW" --policy 0x30000 --comport 1 --snp qemu ) > "$W/build-notable.log" 2>&1 || {
  echo "ABORT: the no-table IGVM did not build"; exit 1; }
# the two IGVMs must be different files, or the cases are one case
cmp -s "$W/measured.igvm" "$W/notable.igvm" && { echo "ABORT: both IGVMs are identical"; exit 1; }

# THE PLANES QEMU, not the distro one. The distro build has no igvm-cfg object at all - it fails with
# "Parameter 'qom-type' does not accept value 'igvm-cfg'" - and run-domain.sh swallows that, so the run looks
# like a refusal. This is the same QEMU the 0b pre-change negative used, so the two are comparable.
QEMU=${QEMU:-$HOME/.cache/enclave-isolation/planeskit/qemu/build/qemu-system-x86_64}
export QEMU
[ -x "$QEMU" ] || { echo "no planes QEMU at $QEMU"; exit 2; }
"$QEMU" -object help 2>&1 | grep -q igvm-cfg || {
  echo "$QEMU has no igvm-cfg object, so it cannot launch an IGVM at all"; exit 2; }
echo "qemu      $QEMU ($("$QEMU" --version | head -1))"

# launched <tag>: did QEMU actually RUN? The "HOST mode=" line proves only that run-domain.sh reached its echo -
# systemd-run starts the unit and the script prints that line whether or not QEMU survived argument parsing, and
# the call site swallows the failure. A run scored from that line alone reported a firmware refusal that was
# really an unsupported QEMU option. So require the serial file QEMU itself creates, and when it is missing, say
# why from the journal rather than leaving it to be guessed.
launched() {
  [ -s "$W/$1.serial" ] && return 0
  unit=$(sed -n 's/.* unit=\([^ ]*\).*/\1/p' "$W/$1.host" 2>/dev/null | head -1)
  [ -n "$unit" ] && journalctl --user -u "$unit" --no-pager 2>/dev/null | \
    grep -aiE "qemu-system|Failed with result" | tail -3 > "$W/$1.why" || true
  return 1
}
# booted = the guest reached its own userspace at all. finished = it ran its whole cycle. The two must be
# separate: waiting on "booted" and stopping stops the guest a second after its FIRST line, which truncated the
# admission cycle and threw away the report the measurement check needs.
booted()   { grep -aq "ADMIT " "$W/$1.evidence" 2>/dev/null; }
finished() { grep -aq "ADMIT report_after_re_admit_hex=" "$W/$1.evidence" 2>/dev/null; }

run() {    # run <tag> <igvm> <image>
  tag=$1; igvm=$2; img=$3
  IGVM=$igvm EVIDENCE_SERIAL=1 FW_DEBUGCON=1 sh "$here/../m3/run-domain.sh" start "$img" snp "$tag" "$W" \
    > "$W/$tag.host" 2>&1 || true
  # Wait for the cycle to COMPLETE, not merely to start; staging a 45 MB runtime image takes well over a minute.
  # A case that never boots falls out on the deadline, which is what the negatives do.
  for _ in $(seq "${WAIT_S:-300}"); do finished "$tag" && break; sleep 1; done
  sh "$here/../m3/run-domain.sh" stop "$tag" "$W" >/dev/null 2>&1 || true
  launched "$tag" || {
    echo "INFRA  $tag: QEMU produced no serial output, so this run says NOTHING about the firmware:"
    [ -s "$W/$tag.why" ] && sed 's/^/         /' "$W/$tag.why" || sed 's/^/         /' "$W/$tag.host" | head -3
    return 1; }
  return 0
}

fails=0
check() { case "$2" in ok) echo "PASS $1";; infra) echo "INFRA $1"; fails=$((fails+1));; *) echo "FAIL $1"; fails=$((fails+1));; esac; }
said() { grep -aq "$2" "$W/$1.debugcon" 2>/dev/null; }

# ---- case 1, the control -------------------------------------------------------------------------------------
run control "$W/measured.igvm" "$GOOD" || { echo "ABORT: the control did not launch. Nothing below would mean anything."; exit 1; }

# INFRA before PASS: a table the firmware cannot parse produces no match and boots anyway, so the absence of a
# match is a broken table and not a result about the guest.
if said control "not found in table"; then
  check "1 control: the firmware found and used the measured table" infra
  echo "       the firmware reports a GUID it could not find, which means it VERIFIED NOTHING and booted anyway:"
  grep -ah "not found in table" "$W/control.debugcon" | head -3 | sed 's/^/         /'
  echo "       this is the fail-open shape: fix the table, do not read the boot as a pass."
  fails=$((fails+1))
else
  said control "Found injected hashes table in secure location" && r=ok || r=no
  check "1a control: the firmware FOUND the measured table in its secure location" $r
  miss=""
  for b in kernel initrd cmdline; do
    said control "Hash comparison succeeded for \"$b\"" || miss="$miss $b"
  done
  [ -z "$miss" ] && r=ok || r=no
  check "1b control: the firmware VERIFIED all three blobs (kernel, initrd, cmdline)" $r
  [ -n "$miss" ] && echo "       no 'Hash comparison succeeded' for:$miss"
  booted control && r=ok || r=no
  check "1c control: and the guest actually booted under that verification" $r
fi

# the SVSM must have left the hash page out of the ranges it validates and zeroes
hp=$(grep -aoE "Measured SEV hash table \[0x[0-9a-f]+-0x[0-9a-f]+\] excluded from validation" "$W/control.serial" | head -1)
[ -n "$hp" ] && r=ok || r=no
check "2a the SVSM excluded the measured hash page from validation (it says so itself)" $r
[ -n "$hp" ] && echo "       $hp"
# and no Validating range may contain it: 0x810000 must appear as a boundary, never inside
base=$(grep -aoE "Measured SEV hash table at 0x[0-9a-f]+" "$W/build-measured.log" | head -1 | grep -oE "0x[0-9a-f]+")
bad=$(python3 - "$W/control.serial" "$base" <<'PY'
import sys, re
page = int(sys.argv[2], 16)
bad = []
for l in open(sys.argv[1], 'rb').read().decode('utf-8', 'replace').splitlines():
    m = re.search(r'Validating (0x[0-9a-f]+)-(0x[0-9a-f]+)', l)
    if m:
        s, e = int(m.group(1), 16), int(m.group(2), 16)
        if s <= page < e:
            bad.append(l.strip())
print('\n'.join(bad))
PY
)
[ -z "$bad" ] && r=ok || r=no
check "2b and no validated range contains it, so it was never zeroed" $r
[ -n "$bad" ] && echo "       $bad"
grep -acE "Validating 0x" "$W/control.serial" >/dev/null 2>&1 && \
  echo "       validated ranges: $(grep -aoE "Validating 0x[0-9a-f]+-0x[0-9a-f]+" "$W/control.serial" | sed 's/Validating //' | tr '\n' ' ')"

# ---- the measurement link ------------------------------------------------------------------------------------
# The firmware verifying the artifacts is worth nothing to a remote verifier unless the digest that covers them is
# the digest in the signed report. igvmmeasure predicts it offline; the report states it from hardware. They must
# be equal, and this compares them from the report's BYTES rather than from either tool's say-so.
finished control && r=ok || r=no
check "5a control: the guest completed its admission cycle and produced a report" $r
if [ "$r" = ok ]; then
  rep=$(grep -a "ADMIT report_after_re_admit_hex=" "$W/control.evidence" | tail -1 | sed 's/.*hex=//' | tr -d '\r\n ')
  pred=$("$KIT/target/release/igvmmeasure" "$W/measured.igvm" measure | grep -i "Launch Digest" | sed 's/.*: *//' | tr -d ' ')
  # SNP attestation report: MEASUREMENT is 48 bytes at offset 0x90.
  live=$(printf '%s' "$rep" | cut -c$((0x90 * 2 + 1))-$((0x90 * 2 + 96)) | tr 'a-f' 'A-F')
  if [ -n "$live" ] && [ "$live" = "$(printf '%s' "$pred" | tr 'a-f' 'A-F')" ]; then r=ok; else r=no; fi
  check "5b and the report's MEASUREMENT equals igvmmeasure of the launched IGVM" $r
  echo "       igvmmeasure $pred"
  echo "       report      $live"
fi

# ---- case 2, substitution ------------------------------------------------------------------------------------
run substitution "$W/measured.igvm" "$OTHER" || { echo "ABORT: the substitution case did not launch."; exit 1; }
if booted substitution; then
  r=no
  echo "       the guest BOOTED on an initrd the IGVM did not measure. The binding does not hold."
elif said substitution 'Hash comparison failed for "initrd"'; then
  r=ok
  echo "       the firmware's own verdict: $(grep -ah 'Hash comparison failed' "$W/substitution.debugcon" | head -1)"
else
  r=infra
  echo "       INCONCLUSIVE: no boot and no verdict. A SIGTERMed QEMU looks the same. Score the firmware's words."
fi
check "3 substitution: a DIFFERENT initrd under the same measured IGVM is REFUSED" $r

# ---- case 3, no table ----------------------------------------------------------------------------------------
run notable "$W/notable.igvm" "$GOOD" || { echo "ABORT: the no-table case did not launch."; exit 1; }
if booted notable; then
  r=no
  echo "       the guest booted with NO table, so this firmware is not verifying and case 1 proves nothing."
elif said notable "no hashes table"; then
  r=ok
  echo "       the firmware's own verdict: $(grep -ah "no hashes table" "$W/notable.debugcon" | head -1)"
else
  r=infra
fi
check "4 no-table control: without a measured table the same firmware still REFUSES" $r

echo
echo "M4b-step2: $([ $fails -eq 0 ] && echo "all checks passed" || echo "$fails check(s) not passed")"
echo "evidence in $W (serial, evidence, debugcon and host log per case)"
exit $fails
