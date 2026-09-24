#!/bin/sh
# Refuse a launch whose artifacts are not the ones the IGVM measured, BEFORE launching it.
#
# WHY THIS AND NOT THE FIRMWARE. The measured firmware already refuses a substituted initrd, and that refusal is
# the security property. But it is a poor DIAGNOSTIC: the guest simply does not boot, and "Hash comparison failed
# for initrd" reads identically whether someone swapped the image or whether the operator pointed the launcher at
# last week's build. One is an attack and the other is a mistake, and they should not look the same. This says
# which artifact differs, by name, before anything runs.
#
# It is NOT a substitute for the firmware check. This runs on the host, so it is exactly as trustworthy as the
# host; the firmware's check is inside the measurement. Both exist, and only one of them is evidence.
#
# THE IGVM IS PART OF WHAT IS CHECKED. Without it a manifest can be paired with a different IGVM - a stale
# manifest beside a rebuilt file, or the reverse - and everything else matches, so the check passes and the
# mismatch only surfaces after launch as a measurement that does not equal the prediction. That reads like a
# measurement bug rather than like the operator launching the wrong pair. Checking the IGVM binds both sides.
#
#   usage: check-manifest.sh <manifest.json> <igvm> <kernel> <initrd> <cmdline> <firmware>
set -e
M=${1:?usage: check-manifest.sh <manifest.json> <igvm> <kernel> <initrd> <cmdline> <firmware>}
G=${2:?}; K=${3:?}; I=${4:?}; C=${5:?}; F=${6:?}
[ -r "$M" ] || { echo "no manifest at $M"; exit 2; }
bad=0
cmp_field() {   # cmp_field <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf '  ok    %s\n' "$1"
  else
    printf '  WRONG %s\n        manifest: %s\n        served:   %s\n' "$1" "$2" "$3"
    bad=1
  fi
}
get() { python3 -c 'import json,sys; d=json.load(open(sys.argv[1]));
ks=sys.argv[2].split("."); v=d
for k in ks: v=v[k]
print(v)' "$M" "$1"; }
sha() { sha256sum "$1" | cut -c1-64; }
echo "checking the launch against $M"
cmp_field "igvm"     "$(get igvm.sha256)"          "$(sha "$G")"
cmp_field "kernel"   "$(get guest.kernel.sha256)"  "$(sha "$K")"
cmp_field "initrd"   "$(get guest.initrd.sha256)"  "$(sha "$I")"
cmp_field "cmdline"  "$(get guest.cmdline)"        "$C"
cmp_field "firmware" "$(get firmware.sha256)"      "$(sha "$F")"
if [ $bad -ne 0 ]; then
  echo "REFUSING: this manifest, this IGVM and these artifacts are not one set."
  echo "          A wrong artifact surfaces later as \"Hash comparison failed\", which reads the same as an"
  echo "          attack; a wrong IGVM surfaces later as a measurement that differs from the prediction, which"
  echo "          reads like a measurement bug. Neither is how an operator should learn they launched the wrong"
  echo "          pair. Fix the inputs, or rebuild the IGVM over the ones you mean to serve."
  exit 1
fi
echo "  all five match: the IGVM, and the four things its measurement covers"
