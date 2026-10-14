#!/bin/sh
# The app a plane serves is the component of the bundle it ADMITTED - on hardware, one plane at a time.
#
#   good       verify-plane.sh, all its checks, including 11 (the runtime was handed the component cut from the
#              admitted bundle, sealed, and mapped no /app.wasm)
#   decoy      the same image PLUS a different component (label DECOY) at /app.wasm, where the old planeinit ran it
#              from. It must still pass every check AND serve exactly what the good plane served, never DECOY.
#   truncated  the bundle with its last 4 KiB missing: the SVSM must refuse it (0x80001004) and the plane power off
#   missing    no /app.bundle at all: nothing is admitted, nothing named, the plane powers off
#
# The negatives are built as verify-runtime-set.sh builds its own: under an IGVM whose measured table covers THAT
# image (so the firmware lets it boot) and whose SVSM is the good run's binary built for the good bundle - so the
# refusal can only come from admission. A negative that died for another reason scores as a failure.
#
#   usage: verify-app-binding.sh <app.bundle> [workdir]
set -e
here=$(cd "$(dirname "$0")" && pwd)
BUNDLE=${1:?usage: verify-app-binding.sh <app.bundle> [workdir]}
W=${2:-$HOME/enclave-bench/m4b-app-$(date +%H%M%S)}
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
body() { sed -n 's/^RESULT app_body=\(.*\)/\1/p' "$1" | head -1; }

# a genuinely different component: the label is compiled in
M2_LABEL=DECOY cargo build --release --locked --target wasm32-wasip2 \
  --manifest-path "$here/../m2/app/Cargo.toml" --target-dir "$W/target-decoy" 2> "$W/cargo-decoy.txt"
cp "$W/target-decoy/wasm32-wasip2/release/m2_app.wasm" "$W/decoy.wasm"

echo "== good: the plane that must serve its admitted app (verify-plane.sh)"
rc=0; "$here/verify-plane.sh" "$BUNDLE" "$W/good" > "$W/good.txt" 2>&1 || rc=$?
sed 's/^/  /' "$W/good.txt"
[ $rc = 0 ] && r=ok || r=no
check "G the good plane passed every verify-plane.sh check (rc=$rc)" $r
good_body=$(body "$W/good/client.out")

echo "== decoy: the same image plus a DIFFERENT component at /app.wasm"
rc=0; APP_MUTATE="decoy:$W/decoy.wasm" "$here/verify-plane.sh" "$BUNDLE" "$W/decoy" > "$W/decoy.txt" 2>&1 || rc=$?
sed 's/^/  /' "$W/decoy.txt"
decoy_body=$(body "$W/decoy/client.out")
echo "   good served  $good_body"
echo "   decoy served $decoy_body"
stray=$(tr -d '\000' < "$W/decoy/P.evidence" | sed 's/\x1b\[[0-9;=?]*[A-Za-z]//g' | grep -ao "PLANE stray_app_wasm=.*" | head -1)
echo "   $stray"
[ $rc = 0 ] && [ -n "$good_body" ] && [ "$decoy_body" = "$good_body" ] && r=ok || r=no
case "$decoy_body" in *DECOY*) r=no ;; esac
[ -n "$stray" ] || r=no
check "D with a decoy at /app.wasm the plane passes every check, serves EXACTLY the admitted app, and reports the decoy unused" $r

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

neg() {   # neg <name> <APP_MUTATE>
  name=$1; mut=$2; N=$W/$name
  mkdir -p "$N"
  echo "== $name: APP_MUTATE=$mut, SVSM built for the GOOD bundle"
  APP_MUTATE=$mut "$here/build-plane-guest.sh" "$W/good/app.bundle" "$N/plane.cpio.gz" > "$N/build-guest.txt" 2>&1
  BUILDLOG=$N/svsm-build.log "$here/build-measured-igvm.sh" -o "$N/plane.igvm" -i "$N/plane.cpio.gz" -f "$FW" \
    > "$N/build-igvm.txt" 2>&1 || { echo "ABORT: the $name IGVM did not build"; tail -6 "$N/build-igvm.txt"; exit 1; }
  [ "$(j "$N/plane.manifest.json" identity.ENCLAVE_APP_IDS)" = "$Z,$appid" ] \
    && [ "$(j "$N/plane.manifest.json" svsm.elf)" = "$good_svsm" ] \
    && [ "$(j "$N/plane.manifest.json" igvm.launchDigest)" != "$good_digest" ] && r=ok || r=no
  check "${name}0 its SVSM is the good run's binary built for the good bundle, and its launch digest differs from the good one" $r
  IGVM=$N/plane.igvm EVIDENCE_SERIAL=1 FW_DEBUGCON=1 sh "$here/../m3/run-domain.sh" start "$N/plane.cpio.gz" \
    snp P "$N" 2 2048 > "$N/P.host" 2>&1 || true
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
  check "${name}1 the firmware verified all three blobs, so the plane booted the image it was measured over" $r
  for k in "bundle=" "refusal=" "serving=" "reason="; do [ -n "$(ev "$k")" ] && echo "       $(ev "$k")"; done
  echo "       SVSM: $(tr -d '\000' < "$N/P.serial" | grep -ao "SVSM appid: .*" | tr '\n' ';')"
  r=ok
  ev "serving=" | grep -q "serving=NO" || r=no
  [ -z "$(ev "whoami=")" ] || r=no
  [ -z "$(ev "app=")" ] || r=no
  tr -d '\000' < "$N/P.serial" | grep -aq "admitted kind\|DOM serving\|registered a" && r=no
  check "${name}2 nothing was admitted, named, registered or served, no component was handed to a runtime, and the plane powered off" $r
}

neg truncated truncate
r=ok
tr -d '\000' < "$W/truncated/P.evidence" | grep -aq "PLANE bundle=REFUSED" || r=no
tr -d '\000' < "$W/truncated/P.evidence" | grep -aq "PLANE refusal=.*rax_out=0x80001004" || r=no
check "truncated3 the SVSM REFUSED the truncated bundle with 0x80001004, the digest-mismatch code" $r

neg missing drop
r=ok
tr -d '\000' < "$W/missing/P.evidence" | grep -aq "PLANE bundle=reading the bundle failed: /app.bundle: No such file or directory" || r=no
check "missing3 with no bundle the plane refused before any admission call, naming the missing file" $r

echo
echo "M4b-app-binding: $([ $fails -eq 0 ] && echo "all checks passed" || echo "$fails check(s) not passed")"
echo "runs in $W: good/ decoy/ truncated/ missing/"
exit $fails
