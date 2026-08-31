#!/usr/bin/env bash
# probe-device.sh -- can THIS handset host the Shielded trust anchor, and at which tier?
#
# Run against a phone over adb (USB debugging on, "Allow" tapped):
#     ./probe-device.sh                 # first connected device
#     ./probe-device.sh -s <serial>     # a specific one
#
# Buying decisions for this tier have been wrong twice from spec sheets: the S21+
# is "a Snapdragon flagship with TrustZone" and yet every hardware-trust route on
# it is closed (shielded/anchor/REPORT.md section 1). So this asks the device.
#
# It reports a TIER, not a score:
#
#   AVF-PVM     protected VMs available  -> the anchor can run isolated from the
#               host OS, with verified boot intact and a DICE/RKP attestation
#               chain a remote verifier can check. The target.
#   VENDOR-TA   a TrustZone TA could exist here IF a vendor signs it -- which is
#               a business relationship, not a device property, so this is never
#               something a purchase alone unlocks.
#   NORMAL      the arithmetic runs and is bit-exact, but in normal world, with
#               no isolation from a root-level adversary. NOT "attested".
#   UNUSABLE    not even that.
#
# Nothing here writes to the device or changes any setting.

set -u
ADB="${ADB:-adb}"
SERIAL_ARGS=()
[ "${1:-}" = "-s" ] && { SERIAL_ARGS=(-s "$2"); shift 2; }
sh_() { "$ADB" "${SERIAL_ARGS[@]}" shell "$@" 2>/dev/null | tr -d '\r'; }
prop() { sh_ getprop "$1"; }

if ! "$ADB" "${SERIAL_ARGS[@]}" get-state >/dev/null 2>&1; then
    echo "no device: enable USB debugging and tap Allow (adb devices should say 'device')" >&2
    exit 2
fi

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; grn=$'\033[32m'; yel=$'\033[33m'; rst=$'\033[0m'
yes_() { printf '%s  %-46s %s%s\n' "$grn" "$1" "yes${2:+ — $2}" "$rst"; }
no_()  { printf '%s  %-46s %s%s\n' "$red" "$1" "NO${2:+ — $2}" "$rst"; }
inf_() { printf '%s  %-46s %s%s\n' "$dim" "$1" "$2" "$rst"; }

MODEL=$(prop ro.product.model); SOC=$(prop ro.soc.model)
SOCMAN=$(prop ro.soc.manufacturer); PLAT=$(prop ro.board.platform)
REL=$(prop ro.build.version.release); SDK=$(prop ro.build.version.sdk)
PATCH=$(prop ro.build.version.security_patch)
FIRSTAPI=$(prop ro.product.first_api_level)
VBSTATE=$(prop ro.boot.verifiedbootstate); LOCKED=$(prop ro.boot.flash.locked)

echo
echo "${bold}device${rst}"
inf_ "model / SoC"        "$MODEL  ·  ${SOCMAN:-?} ${SOC:-?} (${PLAT:-?})"
inf_ "android"            "$REL (SDK $SDK, patch $PATCH), launched on API ${FIRSTAPI:-?}"
inf_ "verified boot"      "${VBSTATE:-?}, flash.locked=${LOCKED:-?}"

# ---- tier 1: AVF protected VMs -------------------------------------------
# PROTECTED vs NON-protected is the distinction that matters, and the press gets
# it backwards for our purposes. The "Linux Terminal" everyone tests needs a
# NON-protected VM (an interactive Debian). We want a PROTECTED one (isolated
# from the host OS). Qualcomm's Gunyah is protected-ONLY, so a device can fail
# every Terminal test and still be exactly what we need -- and Samsung Exynos
# is the reverse: Terminal works, protected-VM capability is unpublished.
# AOSP: absence of the hypervisor properties implies absence of the capability.
echo
echo "${bold}AVF / pKVM protected VM${rst}  ${dim}(the tier worth buying for)${rst}"
AVF_OK=1; AVF_PARTIAL=0
# /dev/kvm's PRESENCE is a pKVM indicator, never an access path: AOSP sepolicy
# confines it to crosvm --
#   neverallow { domain -crosvm -ueventd -shell } kvm_device:chr_file getattr;
#   neverallowxperm { domain -crosvm } kvm_device:chr_file ioctl ~{ KVM_CHECK_EXTENSION };
# so no app opens it on any stock Android, AVF or not. The only sanctioned path
# is the AVF VirtualMachine API behind android.software.virtualization_framework,
# which is why that feature flag -- not this node -- gates the verdict below.
if [ -n "$(sh_ 'ls /dev/kvm 2>/dev/null')" ]; then yes_ "/dev/kvm present" "pKVM indicator (apps reach it only via the AVF API)"; else no_ "/dev/kvm present"; AVF_OK=0; fi
# Three hypervisor families, three device nodes. Only pKVM's /dev/kvm is
# reachable by an app on a stock device; the other two are typically root-only,
# so their presence means the silicon can, not that we can.
for hv in "gunyah:Qualcomm Gunyah" "gzvm:MediaTek GenieZone"; do
  node="/dev/${hv%%:*}"; label="${hv#*:}"
  ls_out=$(sh_ "ls -l $node 2>/dev/null")
  if [ -n "$ls_out" ]; then
    perms=$(echo "$ls_out" | tr -s ' ' | cut -d' ' -f1,3,4)
    case "$perms" in
      *root\ root*) inf_ "$node" "$label — $perms (root-only: not app-reachable)" ;;
      *)            inf_ "$node" "$label — $perms" ;;
    esac
  fi
done
HV=$(prop ro.boot.hypervisor.version)
HVVM=$(prop ro.boot.hypervisor.vm.supported)
HVPVM=$(prop ro.boot.hypervisor.protected_vm.supported)
VIRTSUP=$(prop ro.virtualization.supported)
[ -n "$HV" ] && yes_ "ro.boot.hypervisor.version" "$HV" || no_ "ro.boot.hypervisor.version"
case "$HVPVM" in
  1|true) yes_ "protected_vm.supported" "THE ONE WE NEED" ;;
  *)      no_  "protected_vm.supported" "${HVPVM:-unset}"; AVF_OK=0 ;;
esac
case "$HVVM" in
  1|true) yes_ "vm.supported" "non-protected too (Linux Terminal class)" ;;
  *)      inf_ "vm.supported" "${HVVM:-unset} — fine: we do not need this" ;;
esac
[ -n "$VIRTSUP" ] && inf_ "ro.virtualization.supported" "$VIRTSUP"
CMDL=$(sh_ 'cat /proc/cmdline 2>/dev/null' | tr ' ' '\n' | grep 'kvm-arm' | tr '\n' ' ')
[ -n "$CMDL" ] && inf_ "kernel cmdline" "$CMDL" || inf_ "kernel cmdline" "no kvm-arm.mode"
# Attestation is the point of the exercise, and it has its own gates that the
# hypervisor properties do not answer. CTS only REQUIRES pVM remote attestation
# on devices whose first vendor API level is >= 202504 (i.e. launched with
# Android 16); everything older is a silent-skip, so it may work or may not.
VAPI=$(prop ro.vendor.api_level)
RA=$(prop avf.remote_attestation.enabled)
RPHOST=$(prop remote_provisioning.hostname)
if [ -n "$VAPI" ] && [ "$VAPI" -ge 202504 ] 2>/dev/null; then
  yes_ "vendor api level" "$VAPI — pVM attestation is CTS-REQUIRED here"
else
  inf_ "vendor api level" "${VAPI:-unset} — below 202504, so attestation is optional (probe it)"
fi
case "$RA" in
  ""|0) inf_ "avf.remote_attestation.enabled" "${RA:-unset}" ;;
  *)    yes_ "avf.remote_attestation.enabled" "$RA" ;;
esac
[ -n "$RPHOST" ] && inf_ "remote_provisioning.hostname" "$RPHOST"

FEATS=$(sh_ 'pm list features')
if echo "$FEATS" | grep -q 'virtualization_framework'; then yes_ "android.software.virtualization_framework"
else no_ "android.software.virtualization_framework"; AVF_OK=0; fi
if [ -n "$(sh_ 'service list 2>/dev/null | grep -i virtualization')" ]; then yes_ "virtualizationservice running"
else inf_ "virtualizationservice" "not listed"; fi
TERM_PKG=$(sh_ 'pm list packages 2>/dev/null | grep -iE "com.android.virt|linuxterminal|com.android.terminal"')
[ -n "$TERM_PKG" ] && inf_ "AVF packages" "$(echo "${TERM_PKG}" | tr '\n' ' ' | sed 's/package://g')" || inf_ "AVF packages" "none"

# ---- tier 2: what a TrustZone TA would need -------------------------------
echo
echo "${bold}TrustZone TA${rst}  ${dim}(device side only — signing is a business relationship)${rst}"
TEE_NODES=$(sh_ 'ls /dev/tee* /dev/qseecom /dev/qsee* 2>/dev/null' | tr '\n' ' ')
[ -n "$TEE_NODES" ] && inf_ "TEE device nodes" "$TEE_NODES" || inf_ "TEE device nodes" "none visible to shell"
case "${SOCMAN}${SOC}${PLAT}" in
  *QTI*|*qcom*|*lahaina*|*kalama*|*pineapple*|*sun*) inf_ "likely TEE" "Qualcomm QTEE — trustlets signed by the OEM's fused root" ;;
  *Samsung*|*exynos*|*s5e*)                          inf_ "likely TEE" "Samsung TEEGRIS — SDK is strategic-partners-only" ;;
  *) inf_ "likely TEE" "unknown from these properties" ;;
esac
if [ "$(prop sys.oem_unlock_allowed)" = "1" ]; then
  yes_ "bootloader unlockable" "own secure world POSSIBLE"
  inf_ "  caveat" "unlocking sets verifiedbootstate!=green, which breaks"
  inf_ "  "      "remote attestation — see REPORT.md, the trap in unlocking"
else
  no_ "bootloader unlockable" "sys.oem_unlock_allowed=$(prop sys.oem_unlock_allowed)"
fi

# ---- tier 3: the normal-world floor, and how fast it would be -------------
echo
echo "${bold}anchor compute (normal world floor)${rst}"
FEATURES=$(sh_ 'grep -m1 Features /proc/cpuinfo')
for f in asimddp i8mm sve sve2 aes pmull sha2; do
  case " $FEATURES " in *" $f "*) yes_ "cpu: $f" ;; *) no_ "cpu: $f" ;; esac
done
inf_ "cores" "$(sh_ 'nproc') · parts: $(sh_ 'grep "CPU part" /proc/cpuinfo | sort | uniq -c | tr -s " " | tr "\n" " "')"
inf_ "RAM"   "$(sh_ 'grep MemTotal /proc/meminfo' | tr -s ' ')"

# ---- verdict --------------------------------------------------------------
echo
if [ "$AVF_OK" = "1" ]; then
    TIER="AVF-PVM"; COL=$grn
    MSG="protected VMs are available: the anchor can run isolated from the host OS
  with verified boot intact. TWO THINGS STILL TO PROVE on this device, because no
  property answers them:
    1. grant MANAGE_VIRTUAL_MACHINE by adb and call VirtualMachineManager
       .getCapabilities() -- want CAPABILITY_PROTECTED_VM.
    2. from inside a Microdroid payload call AVmPayload_requestAttestation()
       and check for an RKP-backed chain (OID 1.3.6.1.4.1.11129.2.1.29.1).
  Only (2) proves the unit was factory-provisioned for attestation."
else
    TIER="NORMAL"; COL=$yel
    MSG="no protected VMs. The anchor's arithmetic runs and is bit-exact here, but in
  normal world — no isolation from a root-level adversary, so this tier must not
  be described as attested. A TrustZone TA is not a purchase away: it needs the
  OEM's signing key."
fi
printf '%s%sTIER: %s%s\n' "$bold" "$COL" "$TIER" "$rst"
echo "  $MSG"
echo
echo "${dim}  Neither this script nor a spec sheet can tell you whether a vendor will sign"
echo "  a TA. That is the only thing money cannot buy here.${rst}"
echo
