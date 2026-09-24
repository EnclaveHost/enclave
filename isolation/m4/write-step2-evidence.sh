#!/bin/sh
# Write the step-2 evidence file FROM a run's own artifacts.
#
# WHY GENERATED AND NOT WRITTEN. My evidence files have carried, at various points: a sentence that was false for
# the run it described, a claim ("every IGVM built before this run had no firmware") that contradicted another run
# in the same directory, a status line quoting four of six bytes so one field was inference, and an address I had
# read out of the wrong log line. Every one of those was me typing a conclusion next to the data instead of out of
# it. So the quoted lines here are cut from the run's files, and a line that is absent comes out absent rather
# than remembered.
#
# What is NOT generated is the reasoning - what the run means, and what it does not establish. That is written,
# below, and it is the part a reader should distrust and check.
#
#   usage: write-step2-evidence.sh <workdir> > evidence/step2-....txt
set -e
W=${1:?usage: write-step2-evidence.sh <workdir>}
[ -r "$W/run.log" ] || { echo "no run.log in $W" >&2; exit 2; }
q() { grep -ah "$2" "$W/$1" 2>/dev/null | sed 's/^/  /' || true; }
j() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1]))
ks=sys.argv[2].split("."); v=d
for k in ks: v=v[k]
print(v)' "$W/measured.manifest.json" "$1" 2>/dev/null || echo "(absent)"; }

cat <<EOF
Step 2: the launch measurement now covers the kernel, initrd and command line that ACTUALLY EXECUTE
warden-host, $(date +%Y-%m-%d). Generated from $W by m4/write-step2-evidence.sh; the quoted lines are cut from
the run's own files. This is the inversion of evidence/igvm-0b-precondition-2026-09-24.txt, which recorded the
same firmware inside the same kind of IGVM refusing every guest because the table was absent.

WHAT WAS UNDER TEST. On the IGVM path QEMU writes no SEV hash table - it hands the metadata pages to the IGVM
instead - so the guest's kernel, initrd and command line reached the firmware through fw_cfg, outside the launch
measurement. igvmbuilder now emits the table itself as MEASURED page data, which is what puts those three inside
the IGVM digest. Three mechanisms have to hold together: emit the table where the FIRMWARE reads it, keep the
SVSM from validating and zeroing that page, and grant the page to the guest VMPL.

THE BUILD
  IGVM            $(j igvm.path)
                  $(j igvm.bytes) bytes, sha256 $(j igvm.sha256)
  launch digest   $(j igvm.launchDigest)
  firmware        $(basename "$(j firmware.path)"), sha256 $(j firmware.sha256)
                  pinned as VERIFYING by $(basename "$(j firmware.pinnedVerifyingBy)")
  guest kernel    $(j guest.kernel.path), sha256 $(j guest.kernel.sha256)
  guest initrd    $(basename "$(j guest.initrd.path)"), sha256 $(j guest.initrd.sha256)
  guest cmdline   "$(j guest.cmdline)"
  SVSM            $(j svsm.source.base) + 0001 + 0002 + appid.rs, FEATURES=$(j svsm.features), RELEASE
                  elf $(j svsm.elf)
                  igvmbuilder $(j svsm.igvmbuilder)
  app id, plane 2 $(j identity.ENCLAVE_APP_IDS | cut -d, -f2)

WHERE THE TABLE GOES, which is the part that cost a hardware run:
$(q build-measured.log "Measured SEV hash table at")
$(q build-measured.log "Pre-validated regions recorded")

The descriptor declares the PAGE, because that is what gets validated. The firmware reads the table at its own
FixedPcd PcdQemuHashTableBase (0x810c00, offset 0xc00, slot 0x400), which comes from the SEV_HASH_TABLE_RV_GUID
footer entry and NOT from the descriptor. A table at the descriptor's base is invisible: the first run of this
fixture put it there, every structural check passed, and the firmware reported no table and booted nothing.

THE FIRMWARE'S OWN WORDS, control (I/O port 0x402, FW_DEBUGCON=1):
$(q control.debugcon "Found injected hashes table")
$(q control.debugcon "Hash comparison succeeded")

All three blobs, and that is the acceptance rather than the boot. A malformed table does not refuse: the verifier
searches for a per-blob GUID and treats "not found" as EFI_SUCCESS, so it would verify nothing and boot normally,
silently on a RELEASE build. A booting guest is not evidence that verification happened.

THE SVSM'S OWN WORDS, control - the page is neither validated nor zeroed, and IS granted:
$(q control.serial "Validating 0x")
$(q control.serial "excluded from validation")
$(q control.serial "Firmware region")

Three "Validating" ranges where the 0b run had two, and none contains 0x810000. The secrets, CPUID and CAA pages
sit at 0x80d000/0x80e000/0x80f000 and used to BRIDGE the gap so everything merged into 0x80a000-0x830000; the
split leaves a one-page hole, which breaks the merge because validate_fw_memory_vec merges only contiguous
regions. "Firmware region 2" is the grant: rmp_adjust to the guest VMPL, no PVALIDATE, no zeroing, which is what
a launch-measured page needs.

THE MEASUREMENT LINK - the digest covering those artifacts is the digest in the signed report:
$(sed 's/^/  /' "$W/measurement.check" 2>/dev/null || echo "  (absent)")

SUBSTITUTION: the same IGVM, one different initrd:
$(q substitution.debugcon "Hash comparison")
  guest markers in the substituted run: $(grep -ac "ADMIT " "$W/substitution.evidence" 2>/dev/null || echo 0)

The kernel still verifies - it is the same kernel - and the initrd does not. No guest marker at all, because the
verifier dead-loops rather than returning.

NO-TABLE CONTROL: the same firmware, an IGVM with no measured table:
$(q notable.debugcon "no hashes table")
  guest markers: $(grep -ac "ADMIT " "$W/notable.evidence" 2>/dev/null || echo 0)

This one is not redundant. Without it, the control passing is equally consistent with a firmware that checks
nothing, and the substitution failing to boot is equally consistent with a broken image.

THE SCORE
$(grep -E "^PASS|^FAIL|^INFRA" "$W/run.log" | sed 's/^/  /')
$(grep -E "^M4b-step2:" "$W/run.log" | sed 's/^/  /')

WHAT THIS DOES NOT ESTABLISH, and none of it is closed by the run above:

  The pre-launch manifest check is a DIAGNOSTIC, not the security property. It runs on the host, so it is exactly
  as trustworthy as the host. It exists because "Hash comparison failed for initrd" reads identically whether an
  image was swapped or an operator pointed at last week's build, and those should not look the same.

  The firmware pin is by sha256 of a file, at build time. What makes a firmware "verifying" is substitution
  evidence and never its name or its .dsc - a byte-perfect measured table over BlobVerifierLibNull passes every
  structural check there is. Reassembling the firmware from the IGVM's own pages would bind it after the fact
  too; that is the independent reviewer's mechanism and is not in this script.

  The runtime image admitted is the wasmtime ELF only. Its interpreter and shared libraries are not admitted, so
  the bytes that execute include unadmitted code.

  This is ONE app on ONE plane. Nothing here demonstrates isolation between two apps on two planes; the
  second-plane preconditions are in svsm/README.md and remain open.
EOF
