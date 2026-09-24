#!/bin/sh
# The runtime SET on hardware: one plane that must serve, and two that must not.
#
#   good     verify-plane.sh, all its checks, including 9 (the SVSM admitted the whole set) and 10 (the running
#            runtime mapped every admitted ELF and no executable outside it)
#   changed  the same image with ONE byte of /rt/libc.so.6 flipped
#   missing  the same image with /rt/libgcc_s.so.1 absent
#
# WHY THE NEGATIVES ARE BUILT THIS WAY. Each negative is launched under an IGVM whose measured table covers THAT
# image, so the firmware verifies it and lets it boot - and whose SVSM is built with the GOOD set's digest, the same
# SVSM binary the good run measured. Launching a negative under the good IGVM instead would be refused by the
# firmware's initrd hash before the SVSM saw anything (step 2 already shows that), so it would say nothing about
# admission. Built this way, the only thing that can refuse the plane is the SVSM comparing the set it was handed
# with the set it was built for, which is the claim: a changed or missing runtime file cannot inherit the accepted
# identity. The negatives' launch digests also differ from the good one, so a verifier pinning the good digest
# rejects them before any of this; that is the other layer, and it is checked too.
#
# A negative PASSES only if the plane got as far as the runtime (bundle admitted, firmware verified all three blobs)
# and was refused THERE with the SVSM's digest-mismatch code 0x80001004 - a plane that died earlier, or was refused
# for another reason, would be a refusal for the wrong reason and scores as a failure.
#
#   usage: verify-runtime-set.sh <app.bundle> [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
BUNDLE=${1:?usage: verify-runtime-set.sh <app.bundle> [workdir]}
W=${2:-$HOME/enclave-bench/m4b-rtset-$(date +%H%M%S)}
mkdir -p "$W"; W=$(cd "$W" && pwd)
. "$here/../m1/domain.env"
FW=${FW:-$HOME/.cache/enclave-isolation/fwbuild/OVMF.amdsev.debug.fd}
QEMU=${QEMU:-$HOME/.cache/enclave-isolation/planeskit/qemu/build/qemu-system-x86_64}
export FW QEMU
fails=0
check() { case "$2" in ok) echo "PASS $1";; *) echo "FAIL $1"; fails=$((fails+1));; esac; }
j() { python3 -c 'import json,sys
v=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): v=v[k]
print(v)' "$1" "$2"; }

echo "== good: the plane that must serve (verify-plane.sh)"
good_rc=0
"$here/verify-plane.sh" "$BUNDLE" "$W/good" > "$W/good.txt" 2>&1 || good_rc=$?
sed 's/^/  /' "$W/good.txt"
[ $good_rc = 0 ] && r=ok || r=no
check "G the good plane passed every verify-plane.sh check (rc=$good_rc)" $r
appid=$(sed -n 's/.*app id  \([0-9a-f]*\) .*/\1/p' "$W/good/build-guest.txt")
rtsha=$(sed -n 's/.*runtime set     \([0-9a-f]*\) .*/\1/p' "$W/good/build-guest.txt")
rtid=$(sed -n 's/.*runtime id      \([0-9a-f]*\) .*/\1/p' "$W/good/build-guest.txt")
for v in "$appid" "$rtsha" "$rtid"; do
  [ ${#v} = 64 ] || { echo "ABORT: the good run left no digests to build the negatives with"; exit 1; }
done
Z=$(printf '%064d' 0)
export ENCLAVE_APP_IDS="$Z,$appid" ENCLAVE_RUNTIME_SHA256="$Z,$rtsha" ENCLAVE_RUNTIME_IDS="$Z,$rtid"
good_digest=$(j "$W/good/plane.manifest.json" igvm.launchDigest)
good_svsm=$(j "$W/good/plane.manifest.json" svsm.elf)

neg() {   # neg <name> <RT_MUTATE>
  name=$1; mut=$2; N=$W/$name
  mkdir -p "$N"
  echo "== $name: RT_MUTATE=$mut, SVSM built for the GOOD set"
  RT_MUTATE=$mut "$here/build-plane-guest.sh" "$W/good/app.bundle" "$N/plane.cpio.gz" > "$N/build-guest.txt" 2>&1
  nset=$(sed -n 's/.*runtime set     \([0-9a-f]*\) .*/\1/p' "$N/build-guest.txt")
  echo "   this image's set $nset"
  echo "   SVSM expects     $rtsha"
  BUILDLOG=$N/svsm-build.log "$here/build-measured-igvm.sh" -o "$N/plane.igvm" -i "$N/plane.cpio.gz" -f "$FW" \
    > "$N/build-igvm.txt" 2>&1 || { echo "ABORT: the $name IGVM did not build"; tail -6 "$N/build-igvm.txt"; exit 1; }
  ndigest=$(j "$N/plane.manifest.json" igvm.launchDigest)
  [ ${#nset} = 64 ] && [ "$nset" != "$rtsha" ] \
    && [ "$(j "$N/plane.manifest.json" identity.ENCLAVE_RUNTIME_SHA256)" = "$Z,$rtsha" ] \
    && [ "$(j "$N/plane.manifest.json" svsm.elf)" = "$good_svsm" ] && r=ok || r=no
  check "${name}0 the image's set differs from the good one, and its SVSM is the good run's own binary built for the good set" $r
  [ "$ndigest" != "$good_digest" ] && r=ok || r=no
  check "${name}1 its launch digest differs from the good plane's, so a verifier pinning that one rejects it first" $r

  IGVM=$N/plane.igvm EVIDENCE_SERIAL=1 FW_DEBUGCON=1 sh "$here/../m3/run-domain.sh" start "$N/plane.cpio.gz" \
    snp P "$N" 2 2048 > "$N/P.host" 2>&1 || true
  # Guard the files, not just the commands: `< missing` fails in the SHELL, before a 2>/dev/null on tr applies,
  # so the unguarded form printed "No such file or directory" on every poll until QEMU created them.
  for _ in $(seq "${WAIT_S:-240}"); do
    [ -s "$N/P.evidence" ] && tr -d '\000' < "$N/P.evidence" | grep -aq "PLANE serving=NO" && break
    [ -s "$N/P.serial" ] && tr -d '\000' < "$N/P.serial" | grep -aq "DOM serving" && break
    grep -aq "Hash comparison failed\|no hashes table" "$N/P.debugcon" 2>/dev/null && break
    sleep 1
  done
  sleep 2
  sh "$here/../m3/run-domain.sh" stop P "$N" >> "$N/P.host" 2>&1 || true
  [ -s "$N/P.serial" ] || { echo "INFRA: QEMU produced no serial output for $name, so it says nothing"; fails=$((fails+1)); return; }
  ev() { tr -d '\000' < "$N/P.evidence" 2>/dev/null | sed 's/\x1b\[[0-9;=?]*[A-Za-z]//g' | grep -ao "PLANE $1.*" | head -1; }
  r=ok
  for b in kernel initrd cmdline; do grep -aq "Hash comparison succeeded for \"$b\"" "$N/P.debugcon" || r=no; done
  ev "bundle=" | grep -q "bundle=admitted" || r=no
  check "${name}2 the firmware verified all three blobs and the bundle was admitted, so the plane reached its runtime" $r
  for k in "runtime_set=" "runtime=" "refusal=" "serving=" "reason="; do echo "       $(ev "$k")"; done
  ev "runtime=" | grep -q "runtime=REFUSED" && ev "refusal=" | grep -q "rax_out=0x80001004" && r=ok || r=no
  check "${name}3 the SVSM REFUSED the runtime set with 0x80001004, the digest-mismatch code - not some other refusal" $r
  r=ok
  ev "serving=" | grep -q "serving=NO" || r=no
  [ -z "$(ev "whoami=")" ] || r=no
  tr -d '\000' < "$N/P.serial" | grep -aq "DOM serving\|DOM plane .*registered" && r=no
  tr -d '\000' < "$N/P.serial" | grep -aq "admitted kind 1" && r=no
  check "${name}4 and the plane was never named, never registered a key and never served: it powered off" $r
}

neg changed flip:libc.so.6
neg missing drop:libgcc_s.so.1

echo
echo "M4b-runtime-set: $([ $fails -eq 0 ] && echo "all checks passed" || echo "$fails check(s) not passed")"
echo "runs in $W: good/ changed/ missing/"
exit $fails
