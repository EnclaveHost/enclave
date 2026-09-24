#!/bin/sh
# Does this firmware actually VERIFY the SEV kernel hash table?
#
# WHY THIS EXISTS. `kernel-hashes=on` makes QEMU write a table of sha256(kernel), sha256(initrd) and
# sha256(cmdline) into a page the launch digest commits to. Whether anything CHECKS the served bytes against that
# table is a property of the FIRMWARE, not of QEMU: upstream OvmfPkgX64 links BlobVerifierLibNull and never looks,
# while OvmfPkg/AmdSev/AmdSevX64.dsc links BlobVerifierLibSevHashes, which compares and fails closed. Measured
# 2026-09-23: the distro OVMF boots happily with NO table at all, so on every kernel-hashes path in this
# repository "the app is in the measured image" was a statement about hashes rather than about what executes.
#
# THE TEST. Two launches of ONE image with ONE firmware:
#
#   kernel-hashes=on    must BOOT            (the control: the table matches what is served)
#   kernel-hashes=off   must NOT BOOT        (no table at all; a verifying firmware refuses, a null one boots)
#
# A firmware that passes both is verifying. A firmware that boots in the second case is not, whatever the digest
# commits to. The third case - serving different bytes than were hashed - needs a QEMU that hashes one file and
# serves another, which is a test-only patch and is run by the review lane rather than here.
#
# usage: verify-firmware.sh <OVMF.fd> <domain.cpio.gz> [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
FW=${1:?usage: verify-firmware.sh <OVMF.fd> <domain.cpio.gz> [workdir]}
IMG=${2:?usage: verify-firmware.sh <OVMF.fd> <domain.cpio.gz> [workdir]}
W=${3:-$(mktemp -d)}
mkdir -p "$W"
[ -r "$FW" ] || { echo "no firmware at $FW"; exit 2; }
echo "firmware $FW ($(stat -c %s "$FW") bytes, sha256 $(sha256sum "$FW" | cut -c1-16)...)"

booted() {   # booted <tag>: did the guest reach its own userspace?
  grep -aq "DOM serving\|DOM started" "$W/$1.serial" 2>/dev/null
}

run() {      # run <tag> <on|off>
  tag=$1; hashes=$2
  sed "s/kernel-hashes=on/kernel-hashes=$hashes/" "$here/run-domain.sh" > "$here/.fwtest-run.sh"
  OVMF_OVERRIDE=$FW sh "$here/.fwtest-run.sh" start "$IMG" snp "$tag" "$W" > "$W/$tag.host" 2>&1 || true
  for _ in $(seq 40); do booted "$tag" && break; sleep 1; done
  sh "$here/run-domain.sh" stop "$tag" "$W" >/dev/null 2>&1 || true
  rm -f "$here/.fwtest-run.sh"
}

fails=0
check() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }

run control on
booted control && r=ok || r=no
check "1 control: kernel-hashes=on, the table matches what is served, the guest BOOTS" $r

run notable off
booted notable && r=no || r=ok
check "2 kernel-hashes=off: NO table in the measurement, the firmware must REFUSE to boot the guest" $r

echo
if [ "$fails" -eq 0 ]; then
  echo "FIRMWARE VERIFIES: it boots what matches the table and refuses when there is no table."
  echo "Still not shown here, and it needs a test-only QEMU that hashes one file while serving another:"
  echo "that a SUBSTITUTED initrd is refused. Without that case this says the firmware checks for a table,"
  echo "not that it compares the bytes. See isolation/m4/PLAN.md section 3."
else
  echo "$fails of 2 FAILED. If case 2 booted, this firmware does not verify the table:"
  echo "it is almost certainly an OvmfPkgX64 build linking BlobVerifierLibNull. Build AmdSevX64.dsc instead."
  exit 1
fi
echo "workdir $W"
