#!/bin/sh
# M3b: the boundary test, run AFTER booting the planes kernel (isolation/m3/PLAN.md section 13).
#
# This script exists so the boot window is spent on the boundary rather than on assembling commands. It
# runs in stages and stops at the first stage that fails, because the later stages mean nothing if an
# earlier one did not hold:
#
#   A  health       is this kernel safe to keep? If any of these fail: ROLL BACK (reboot, pick the old
#                   GRUB entry). Nothing else is attempted.
#   B  regression   do M1, M2 and M3a still behave EXACTLY as they did on the old kernel? A new kernel
#                   that breaks what worked is not a step forward, whatever else it enables.
#   C  boundary     COCONUT-SVSM at VMPL0 with our monitor guest beneath it, reports at that level, and
#                   the M3a suite re-run against the plane-hosted guest.
#
# What it will NOT do: reboot, install anything, or decide on its own that a weaker result counts. A
# stage that cannot produce its evidence is reported as such.
#
# usage: m3b-verify.sh <workdir> [expected-kernel-release]
set -e
here=$(cd "$(dirname "$0")" && pwd)
# OVMF, for the SNP plane probe in stage A: the same firmware the real launches use
. "$here/../m1/domain.env"
W=${1:?usage: m3b-verify.sh <workdir> [expected-kernel-release]}
WANT_KERNEL=${2:-}
mkdir -p "$W"; W=$(cd "$W" && pwd)
KIT=${KIT:-$HOME/.cache/enclave-isolation}
QEMU=${M3B_QEMU:-$KIT/planeskit/qemu/build/qemu-system-x86_64}
IGVM=${M3B_IGVM:-$KIT/svsmkit/svsm/bin/coconut-qemu.igvm}
PLANE=${M3B_PLANE:-2}
fails=0
gate() { if [ "$2" = ok ]; then echo "PASS $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi; }
stage() { printf '\n======== %s\n' "$1"; }
stop_if_failed() {
  [ "$fails" -eq 0 ] && return 0
  printf '\n%s\n' "$1"
  exit 1
}

stage "A  health: is this kernel safe to keep?"
echo "running kernel: $(uname -r)"
if [ -n "$WANT_KERNEL" ]; then
  [ "$(uname -r)" = "$WANT_KERNEL" ] && r=ok || r=no
  gate "A1 booted the intended kernel ($WANT_KERNEL)" $r
fi
nvidia-smi --query-gpu=name,driver_version --format=csv,noheader > "$W/a-nvidia.txt" 2>&1 && r=ok || r=no
sed 's/^/    /' "$W/a-nvidia.txt" | head -4
gate "A2 the GPUs are usable (the other sessions' CUDA work depends on this)" $r
ip route show default > "$W/a-route.txt" 2>&1 && [ -s "$W/a-route.txt" ] && r=ok || r=no
gate "A3 networking has a default route" $r
getent hosts github.com > /dev/null 2>&1 && r=ok || r=no
gate "A4 DNS resolves" $r
systemctl is-active --quiet sshd && r=ok || r=no
gate "A5 management access is up (sshd active)" $r
# The capability the whole boot is for. Two independent readings, because the first version of this gate
# got it wrong in a way that produced a false ROLL BACK on a perfectly good kernel.
#
# A PLAIN KVM VM CAN NEVER HAVE PLANES ON AMD. arch/x86/kvm/svm/svm.c svm_max_planes() returns
# sev_snp_max_planes() only for ____sev_snp_guest(kvm), and kvm_x86_default_max_planes() = 1 otherwise; on
# top of that kvm_arch_max_planes() requires an in-kernel LAPIC. So probing with a plain VM prints
# "KVM plane 2 is not supported" whether or not the kernel supports planes at all. The probe has to create
# an SNP guest, exactly as run-domain.sh does.
healthA=$fails
lvls=$(journalctl -k -b 2>/dev/null | sed -n 's/.*SEV-SNP enabled .*VMPL Levels \([0-9]*\).*/\1/p' | tail -1)
echo "    the kernel itself reports: VMPL Levels ${lvls:-none reported}"
[ -n "$lvls" ] && [ "$lvls" -gt "$PLANE" ] && r=ok || r=no
gate "A6 the kernel reports more VMPL levels than plane $PLANE needs" $r
# Judged on EXIT STATUS, not on output. A QEMU that was granted the plane keeps running until the deadline,
# so `timeout` kills it and returns 124 - and QEMU prints "terminating on signal 15 ... (timeout)" on its way
# out. Reading "any output means failure" scored that success as a failure, which is the second false verdict
# this gate produced. A refused plane makes QEMU exit by itself, so the status is its own (1), promptly.
snp_plane_probe() { # $1 = plane id; returns 0 if that plane was granted
  timeout 20 "$QEMU" -machine "q35,accel=kvm,confidential-guest-support=sev0,memory-backend=ram1,kernel-irqchip=split,device-plane=$1" \
    -object sev-snp-guest,id=sev0,cbitpos=51,reduced-phys-bits=1 \
    -object memory-backend-memfd,id=ram1,size=512M,share=true \
    -bios "$OVMF" -m 512M -smp 2 -cpu host -display none -nodefaults -no-user-config -S \
    > "$W/a-plane$1.txt" 2>&1
  [ "$?" -eq 124 ]     # 124 = still running at the deadline = the plane was accepted
}
if snp_plane_probe "$PLANE"; then r=ok; else r=no; fi
echo "    plane $PLANE: $(sed -n 1p "$W/a-plane$PLANE.txt" 2>/dev/null || true)"
gate "A7 an SNP guest is actually GRANTED plane $PLANE (this is what the boot was for)" $r
# The negative control, in the gate itself: a plane beyond the reported VMPL levels MUST be refused. Without
# it, a probe that accepted everything would look like a pass.
if snp_plane_probe 9; then r=no; else r=ok; fi
echo "    plane 9: $(sed -n 1p "$W/a-plane9.txt" 2>/dev/null || true)"
gate "A7b plane 9 is REFUSED, so A7 is a real test and not one that passes anything" $r
if [ "$healthA" -eq 0 ] && [ "$fails" -gt 0 ]; then
  stop_if_failed "STOP, but the machine is FINE. A1-A5 passed, so this kernel boots, drives the GPUs and
keeps the network: it is safe to leave running and safe for other sessions. What failed is only the plane
capability, so the boundary test cannot proceed. Investigate that rather than rolling back in a hurry -
and note a plain-VM probe can never show planes on AMD, only an SNP guest can."
fi
stop_if_failed "STOP. This kernel is not healthy. ROLL BACK NOW: reboot, or pick the previous GRUB entry.
Do not continue, and do not leave the machine on this kernel for other sessions."

stage "B  regression: does everything that worked still work?"
for t in ../m1/test-m1.sh ../m2/test-m2.sh ./test-m3.sh; do
  name=$(basename "$t" .sh)
  echo "--- $name (on the new kernel)"
  if (cd "$here" && "$t" "$W/$name") > "$W/b-$name.log" 2>&1; then r=ok; else r=no; fi
  tail -3 "$W/b-$name.log" | sed 's/^/    /'
  gate "B:$name passes unchanged on the new kernel" $r
done
stop_if_failed "STOP. The new kernel changed behaviour that used to pass. That is a finding, not a
detail: investigate it before going further, and ROLL BACK if the machine has to be usable meanwhile.
The logs are in $W/b-*.log."

stage "C  the boundary: COCONUT-SVSM at VMPL0, our monitor beneath it"
echo "qemu: $QEMU"
echo "igvm: $IGVM ($(stat -c %s "$IGVM" 2>/dev/null || echo missing) bytes)"
echo "igvm digest: $("$KIT/svsmkit/svsm/bin/igvmmeasure" "$IGVM" measure -b 2>&1 | tr -d '\r\n')"
# The same 30-check M3a suite, launched through the SVSM with the guest on a lower plane, and every
# trusted client demanding reports from exactly that level. What must change versus M3a: the monitor's
# own kernel reports vmpl=$PLANE, and evidence from level 0 is refused.
if (cd "$here" && QEMU="$QEMU" IGVM="$IGVM" PLANE="$PLANE" VMPL="$PLANE" ./test-m3.sh "$W/m3b") \
     > "$W/c-m3b.log" 2>&1; then r=ok; else r=no; fi
grep -aE '^(PASS|FAIL) 3e|^M3a:|^FAIL' "$W/c-m3b.log" | head -12 | sed 's/^/    /'
gate "C1 the M3a suite passes with the guest on plane $PLANE under the SVSM" $r
# C2 is the VMPL0-REFUSAL gate, not a grep for the level. A report naming VMPL$PLANE is equally consistent
# with being confined beneath a VMPL0 monitor and with being VMPL0 and saying so, because a guest at VMPL0
# holds every VMPCK and may request a report naming a lower level. Only a REFUSAL at level 0 separates them.
if g=$("$here/boundary-gate.sh" "$W/m3b/s1.serial" "$PLANE" 2>&1); then r=ok; else r=no; fi
echo "    $g"
gate "C2 the monitor was REFUSED a report at VMPL0 while running at VMPL$PLANE, in exactly one coherent record: the only part of this that cannot be faked by a VMPL0 guest" $r
grep -aq 'PASS 3e' "$W/c-m3b.log" && r=ok || r=no
gate "C3 check 3e passed: the same tuple reached every trusted client inside the attestation document over the domain's attested TLS, and the signed report agreed with it" $r
# The monitor refuses to serve any report at all on an incoherent tuple, so a FAULT line means it died
# rather than served - which is the fail-closed behaviour, but it is not a pass.
if grep -aq 'MON BOUNDARY FAULT' "$W/m3b"/*.serial 2>/dev/null; then
  echo "    the monitor refused to serve:"; grep -ah 'MON BOUNDARY FAULT' "$W/m3b"/*.serial | head -3 | sed 's/^/      /'
  r=no
else r=ok; fi
gate "C3b no guest reported a boundary fault (the monitor refuses to serve reports at all when its own tuple is incoherent)" $r
grep -aq 'PASS 10 ' "$W/c-m3b.log" && grep -aq 'PASS 10c' "$W/c-m3b.log" && r=ok || r=no
gate "C4 the compromised-domain adversary is still contained, now beneath the SVSM" $r

printf '\n======== result\n'
if [ "$fails" -eq 0 ]; then
  cat <<'EOF'
ALL STAGES PASSED.

What this establishes, stated as precisely as the evidence allows:
  * the launch measurement is the IGVM's, which places COCONUT-SVSM at VMPL0. This is the part that is
    hardware-authenticated, and it is what actually establishes who holds VMPL0 - a verifier holding the
    expected IGVM digest learns that the measured SVSM is the occupant.
  * our monitor and its domains run on a lower plane, the signed report says so, and a verifier that
    demands that level accepts it while one that does not refuses it.
  * the monitor was REFUSED a report at VMPL0, in exactly one coherent record, and it would have refused
    to serve any report at all had that not held.
  * M1, M2 and M3a still pass.

What it does NOT establish, and must not be written up as if it did:
  * A REPORT NAMING A LOWER LEVEL IS NOT PROOF OF CONFINEMENT. A guest at VMPL0 holds every VMPCK and can
    request a signed report naming VMPL1-3. The level field alone therefore never distinguishes "confined
    beneath a VMPL0 monitor" from "at VMPL0 and saying otherwise".
  * The refusal that does distinguish them is NOT hardware-attested. The PSP does not attest "this guest
    cannot reach VMPL0". A verifier relies on measured monitor code truthfully performing and reporting its
    own local refusal - the code is covered by the measurement and fails closed, which is why the claim is
    worth making, but the reliance is an assumption and not a checked fact. Say so wherever this is written
    up; see isolation/m2/judge.mjs checkBoundary and isolation/DESIGN.md.
  * APP-VS-APP ISOLATION BY HARDWARE. Inside our plane, one domain is still separated from another by the
    guest kernel. Per-app hardware separation needs one plane per app, and vmpl_count=4 caps that at three
    domains per guest.
EOF
else
  echo "$fails gate(s) failed. Investigate and write up what happened; do not weaken a check to make it"
  echo "pass, and do not leave the machine on this kernel for the other sessions if stage A failed."
  exit 1
fi
